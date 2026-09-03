"""Phase 7/8's async worker pool entrypoint (ADR-0060/§7.2). Run as:

    python -m app.worker

Claims one `queued` job at a time (`app/services/queue_service.py`'s
`SELECT ... FOR UPDATE SKIP LOCKED`), executes it
(`job_service.execute_job` - gRPC pulls, decomposition, `solve()`,
persistence, the completion publish), and loops. Runs the reaper sweep
every cycle *before* attempting a claim, so a stuck job gets recovered
promptly rather than waiting behind a full poll interval of otherwise-idle
looping.

Multiple instances of this process can run concurrently against the same
Postgres - horizontal scale is "start more processes," not a code change
(ADR-0060 Decision 1/2).
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import socket

from nats.js import JetStreamContext
from prometheus_client import start_http_server
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import Settings, get_settings
from app.core.logging_config import configure_logging
from app.core.worker_metrics import WORKER_REGISTRY
from app.db.models import ScheduleJob
from app.db.session import dispose_engine, get_session_factory, tenant_scoped_session
from app.events import nats_publisher
from app.services import job_service, queue_service

logger = logging.getLogger("agno.scheduling.worker")


class Worker:
    """One instance per OS process. `run()` loops until `request_drain()`
    has been called (§7.2's graceful draining: a `SIGTERM` handler calls
    this) *and* no claim is currently in flight - a claim already in
    progress always finishes; draining only ever stops the *next* one from
    starting."""

    def __init__(self, *, worker_id: str, js: JetStreamContext, settings: Settings) -> None:
        self._worker_id = worker_id
        self._js = js
        self._settings = settings
        self._draining = asyncio.Event()

    def request_drain(self) -> None:
        if not self._draining.is_set():
            logger.info(
                "worker received shutdown signal - draining, no new jobs will be claimed",
                extra={"fields": {"workerId": self._worker_id}},
            )
        self._draining.set()

    @property
    def is_draining(self) -> bool:
        return self._draining.is_set()

    async def run(self) -> None:
        session_factory = get_session_factory()
        while not self._draining.is_set():
            await self._reap_once(session_factory)
            if self._draining.is_set():
                break
            claimed = await queue_service.claim_next_job(session_factory, worker_id=self._worker_id)
            if claimed is None:
                await asyncio.sleep(self._settings.worker_poll_interval_seconds)
                continue
            await self._execute_claim(session_factory, claimed)

    async def _reap_once(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        reaped = await queue_service.reap_stuck_jobs(
            session_factory,
            threshold_seconds=self._settings.worker_reaper_stuck_threshold_seconds,
            max_attempts=self._settings.worker_reaper_max_attempts,
        )
        for failure in reaped:
            logger.warning(
                "job exhausted reaper max attempts - marked failed",
                extra={
                    "fields": {
                        "jobId": str(failure.job_id),
                        "tenantId": str(failure.tenant_id),
                        "maxAttempts": self._settings.worker_reaper_max_attempts,
                    }
                },
            )
            await nats_publisher.publish_job_completed(
                self._js,
                tenant_id=failure.tenant_id,
                schedule_job_id=failure.job_id,
                org_unit_id=failure.org_unit_id,
                status="failed",
            )

    async def _execute_claim(
        self, session_factory: async_sessionmaker[AsyncSession], claimed: queue_service.ClaimedJob
    ) -> None:
        logger.info(
            "job claimed",
            extra={"fields": {"jobId": str(claimed.job_id), "workerId": self._worker_id}},
        )
        try:
            async with tenant_scoped_session(
                queue_service.tenant_context_for(claimed.tenant_id),
                session_factory=session_factory,
            ) as session:
                job = await session.get(ScheduleJob, claimed.job_id)
                assert job is not None
                await job_service.execute_job(session, js=self._js, job=job)
        except Exception:
            # Anything `job_service.execute_job` didn't already turn into a
            # clean `failed` state itself (a genuine bug, a DB connectivity
            # blip mid-transaction) - the transaction rolls back, so the row
            # stays `solving` exactly as the claim left it. The reaper
            # recovers it on a later cycle (from this worker or another
            # one); logged here, not re-raised, so one bad job never kills
            # the worker process.
            logger.exception(
                "job execution raised an unhandled exception - left for the reaper",
                extra={"fields": {"jobId": str(claimed.job_id), "workerId": self._worker_id}},
            )
        else:
            logger.info(
                "job execution finished",
                extra={"fields": {"jobId": str(claimed.job_id), "workerId": self._worker_id}},
            )


async def _main() -> None:
    configure_logging()
    settings = get_settings()
    worker_id = f"{socket.gethostname()}:{os.getpid()}"

    # §8's own worker-side metrics (solve time distribution, relaxation-
    # category frequency, terminal-status counts) - this process's only
    # HTTP surface, a separate registry/port from the main app's `/metrics`
    # (see `app/core/worker_metrics.py`'s own module docstring for why).
    start_http_server(settings.worker_metrics_port, registry=WORKER_REGISTRY)

    nc = await nats_publisher.connect(settings)
    js = nc.jetstream()
    await nats_publisher.bootstrap_stream(js, settings)

    worker = Worker(worker_id=worker_id, js=js, settings=settings)
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, worker.request_drain)

    logger.info("worker starting", extra={"fields": {"workerId": worker_id}})
    try:
        await worker.run()
    finally:
        logger.info("worker drained, shutting down", extra={"fields": {"workerId": worker_id}})
        await nc.close()
        await dispose_engine()


if __name__ == "__main__":
    asyncio.run(_main())
