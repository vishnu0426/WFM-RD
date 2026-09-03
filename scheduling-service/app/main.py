"""FastAPI service skeleton + §4.1's submit/poll REST contract. Boots with
the `scheduling.jobs` router mounted, same "job scaffolding is named Phase 1
scope, not deferred" posture Module 03 took (see
docs/module-04-phase-1-design-doc.md).

Phase 2 (docs/module-04-phase-2-design-doc.md) wired the CP-SAT solver in
for §3.1's hard constraints, single-site scope - `POST /v1/scheduling/jobs`
now actually solves when given `policy`+`shiftSlots` (ADR-0055), and `GET
/v1/scheduling/jobs/{jobId}/schedule` reads the result back. Phase 3
(docs/module-04-phase-3-design-doc.md) adds §3.2's soft constraints and
§3.3's fairness bound, `POST /v1/scheduling/schedules/{scheduleId}/publish`
(the `FairnessLedger` refresh trigger), and `GET /v1/scheduling/fairness/audit`.
Phase 4 (docs/module-04-phase-4-design-doc.md) adds §5's infeasibility-
handling relaxation search (ADR-0057's ordering/non-relaxable set) and
`POST /v1/scheduling/jobs/{jobId}/relaxation/approve`, the human-approval
gate §5 point 4 requires. Phase 5 adds the manual-override/locked-assignment
re-optimization path. Phase 6 adds the mid-solve gRPC data pulls (replacing
ADR-0055's request-supplied data) and the Module 10 explanation-generation
handoff. Phase 7/8 (docs/module-04-phase-7-design-doc.md,
-phase-8-design-doc.md, ADR-0060/0061) move solving off this process
entirely: every `POST` here now only enqueues (`app/api/v1/jobs.py`'s own
module docstring) - `app/worker.py` is the process that actually pulls
data, decomposes, solves, and persists, with graceful draining and a
reaper for jobs stuck in `solving`. This file no longer does any CP-SAT
work at all, directly or indirectly.

Module 05 Phase 2 (docs/adr/0064) adds `GET
/v1/scheduling/employees/{employeeId}/shift-assignments` (`employees_router`)
and two new NATS events (`agno.scheduling.schedule.published.v1`,
`agno.scheduling.assignment.changed.v1`, published from `publish_schedule`/
`override_assignment`) - the read/event surface intraday-service needs for
its `scheduled_activity` pre-load. Added post-hoc; no other endpoint's
behavior changed.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import grpc
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from nats.js import JetStreamContext

from app.api.v1.employees import router as employees_router
from app.api.v1.jobs import router as jobs_router
from app.api.v1.project_rules import router as project_rules_router
from app.api.v1.schedules import router as schedules_router
from app.api.v1.shift_assignments import router as shift_assignments_router
from app.api.v1.shift_event_requests import router as shift_event_requests_router
from app.api.v1.shift_templates import router as shift_templates_router
from app.api.v1.staffing_profiles import router as staffing_profiles_router
from app.api.v1.work_patterns import router as work_patterns_router
from app.config import get_settings
from app.core.errors import DomainError
from app.core.health import router as health_router
from app.core.logging_config import configure_logging
from app.core.metrics import MetricsMiddleware, render_metrics
from app.core.middleware import TenantContextMiddleware, domain_error_response
from app.core.request_id import RequestIdMiddleware
from app.db.session import dispose_engine
from app.events import nats_publisher
from app.grpc.generated import (
    schedule_explanation_data_pb2_grpc,
    schedule_query_pb2_grpc,
    scheduling_eligibility_pb2_grpc,
)
from app.grpc.schedule_explanation_data_grpc_server import ScheduleExplanationDataServicer
from app.grpc.schedule_query_grpc_server import ScheduleQueryServicer
from app.grpc.scheduling_eligibility_grpc_server import SchedulingEligibilityServicer
from app.grpc_clients.channels import close_channels
from app.nats import marketplace_consumer

configure_logging()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    nc = await nats_publisher.connect(settings)
    js: JetStreamContext = nc.jetstream()
    await nats_publisher.bootstrap_stream(js, settings)
    app.state.nats_connection = nc
    app.state.jetstream = js

    # Module 07 (docs/adr/0082) - this service's first gRPC server, hosted in
    # the same process as the FastAPI app: `CheckAssignmentEligibility` never
    # touches CP-SAT/`solve()`, so it isn't the CPU-bound work ADR-0060 moved
    # onto `app/worker.py`, and has no reason to live in a separate process.
    grpc_server = grpc.aio.server()
    scheduling_eligibility_pb2_grpc.add_SchedulingEligibilityServiceServicer_to_server(
        SchedulingEligibilityServicer(), grpc_server
    )
    # Module 08 Phase 5 (docs/adr/0103) - second servicer, same process/port:
    # bulk read of published shift assignments, no CP-SAT/CPU-bound work
    # either, same reasoning as the eligibility servicer above.
    schedule_query_pb2_grpc.add_ScheduleQueryServiceServicer_to_server(ScheduleQueryServicer(), grpc_server)
    # Module 10 Phase 2 (docs/adr/0115) - third servicer, same process/port:
    # a plain by-id read of ScheduleJob's own solve-result columns, no
    # CP-SAT/CPU-bound work either.
    schedule_explanation_data_pb2_grpc.add_ScheduleExplanationDataServiceServicer_to_server(
        ScheduleExplanationDataServicer(), grpc_server
    )
    grpc_server.add_insecure_port(settings.scheduling_grpc_bind_address)
    await grpc_server.start()

    # Module 07 Phase 5 (ADR-0089) - this service's first NATS consumer,
    # run as a background task in the same process (event-driven, not
    # CPU-bound - the same "no reason to live in app/worker.py's separate
    # process" reasoning as the gRPC server above).
    marketplace_consumer_stop = asyncio.Event()
    marketplace_consumer_task = asyncio.create_task(marketplace_consumer.run(js, marketplace_consumer_stop))

    try:
        yield
    finally:
        marketplace_consumer_stop.set()
        await marketplace_consumer_task
        await grpc_server.stop(grace=5)
        await nc.close()
        await dispose_engine()
        await close_channels()


app = FastAPI(title="AGNO WFM Scheduling Service", version="0.1.0", lifespan=lifespan)

app.add_middleware(TenantContextMiddleware)
app.add_middleware(RequestIdMiddleware)
app.add_middleware(MetricsMiddleware)
# Starlette builds its middleware stack so the *last*-added middleware ends
# up outermost (wraps every other middleware, runs first on the way in).
# CORSMiddleware must be outermost so it can intercept and short-circuit a
# browser's automatic OPTIONS preflight request before anything else runs -
# added earlier than this, TenantContextMiddleware saw every preflight
# first (preflight requests never carry the app's own Authorization header
# by design) and rejected it with 401, breaking every cross-origin request
# that needs a preflight at all. Same fix as forecasting-service/app/main.py.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in get_settings().cors_origin.split(",")],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health_router)
app.include_router(jobs_router)
app.include_router(schedules_router)
app.include_router(employees_router)
app.include_router(shift_assignments_router)
app.include_router(shift_templates_router)
app.include_router(work_patterns_router)
app.include_router(staffing_profiles_router)
app.include_router(shift_event_requests_router)
app.include_router(project_rules_router)


@app.exception_handler(DomainError)
async def handle_domain_error(_request: Request, exc: DomainError) -> JSONResponse:
    return domain_error_response(exc)


@app.get("/metrics")
async def metrics() -> Response:
    return await render_metrics()
