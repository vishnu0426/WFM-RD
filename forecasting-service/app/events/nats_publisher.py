"""§3.4's event-driven completion path, publishing skeleton only in this
phase - nothing in Phase 1 calls `publish_run_completed` for real, since no
model training exists yet to complete a run (Phase 3+). What's real and
tested here: the connection lifecycle, the idempotent stream bootstrap, and
the publish call's shape/subject/dedup-header contract, so Phase 3+ wires a
real trigger into an already-proven publisher rather than building the NATS
integration under pressure alongside the first real training job.

Replaces the source spec's Kafka reference platform-wide, per the module
prompt's explicit override.
"""

from __future__ import annotations

import json
import uuid
from typing import Literal

import nats
from nats.aio.client import Client as NatsClient
from nats.js import JetStreamContext

from app.config import Settings, get_settings

RUN_COMPLETED_SUBJECT = "agno.forecasting.run.completed.v1"
RunStatus = Literal["completed", "failed"]


async def connect(settings: Settings | None = None) -> NatsClient:
    settings = settings or get_settings()
    return await nats.connect(settings.nats_url)


async def bootstrap_stream(js: JetStreamContext, settings: Settings | None = None) -> None:
    """Idempotent: `add_stream` updates an existing stream with the same name
    rather than erroring, so this is safe to call on every service startup -
    there is no separate out-of-band infra-provisioning step for NATS streams
    anywhere in this platform yet (design doc assumption #7)."""
    settings = settings or get_settings()
    await js.add_stream(name=settings.nats_stream_name, subjects=["agno.forecasting.>"])


async def publish_run_completed(
    js: JetStreamContext,
    *,
    tenant_id: uuid.UUID,
    forecast_run_id: uuid.UUID,
    org_unit_id: uuid.UUID,
    status: RunStatus,
) -> None:
    payload = {
        "tenantId": str(tenant_id),
        "forecastRunId": str(forecast_run_id),
        "orgUnitId": str(org_unit_id),
        "status": status,
    }
    # §3.4's idempotent-consumer key (forecastRunId + status) doubles as the
    # JetStream message-dedup id, so a redelivered publish (e.g. a retried
    # call after a network blip) is deduplicated at the broker, not just at
    # the Node consumer.
    msg_id = f"{forecast_run_id}:{status}"
    await js.publish(
        RUN_COMPLETED_SUBJECT,
        json.dumps(payload).encode("utf-8"),
        headers={"Nats-Msg-Id": msg_id},
    )
