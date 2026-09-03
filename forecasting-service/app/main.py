"""Module 03 Phase 1 - FastAPI service skeleton + §3.3's submit/poll REST
contract. Boots with the `forecasting.jobs` router mounted, unlike Module
01's Phase 1 app (which booted with zero routes) - "job scaffolding" is named
Phase 1 scope here (§7), not deferred the way Module 01/02 deferred their
HTTP surfaces. See docs/module-03-phase-1-design-doc.md.

Phase 2 (docs/adr/0020) adds the `historical_actuals`/`queue-profiles`/
`data-quality` routers the gate and cold-start fallback need. Phase 3
(docs/adr/0021) adds the `models` router (train/list) and wires real
SARIMA/Prophet inference into job fulfillment. Phase 5 (docs/adr/0023) adds
the `service-level-targets` router and Erlang C headcount conversion.
Phase 6 (docs/adr/0024) adds the `scenarios` router. Phase 7 (docs/adr/0025)
adds the `accuracy` and `special-events` routers and the `models` router's
`/staleness` sub-route. Phase 8 (docs/adr/0026) adds the `admin` router
(`tenant_settings` write path), the `models` router's `/provenance`
sub-route, `/healthz`+`/readyz` (replacing the old bare `/health`),
`/metrics`, and structured request logging. Phase 6 (docs/adr/0059) adds
this service's first gRPC surface, `ForecastService.GetForecastRequirements`
- Module 04's mid-solve pull for coverage requirements - booted alongside
the HTTP app here, mirroring Module 01/02's own `connectMicroservice`
pattern (`src/main.ts`), adapted to this service's `grpc.aio`/asyncio stack.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import grpc
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from nats.js import JetStreamContext

from app.api.v1.accuracy import router as accuracy_router
from app.api.v1.actuals import router as actuals_router
from app.api.v1.admin import router as admin_router
from app.api.v1.allocations import router as allocations_router
from app.api.v1.backlog_age_templates import router as backlog_age_templates_router
from app.api.v1.backlog_snapshots import router as backlog_snapshots_router
from app.api.v1.campaigns import router as campaigns_router
from app.api.v1.cc_queues import router as cc_queues_router
from app.api.v1.data_quality import router as data_quality_router
from app.api.v1.jobs import router as jobs_router
from app.api.v1.models import router as models_router
from app.api.v1.queue_analytics import router as queue_analytics_router
from app.api.v1.queue_profiles import router as queue_profiles_router
from app.api.v1.scenarios import router as scenarios_router
from app.api.v1.service_level_targets import router as service_level_targets_router
from app.api.v1.special_events import router as special_events_router
from app.config import get_settings
from app.core.errors import DomainError
from app.core.health import router as health_router
from app.core.logging_config import configure_logging
from app.core.metrics import MetricsMiddleware, render_metrics
from app.core.middleware import TenantContextMiddleware, domain_error_response
from app.core.request_id import RequestIdMiddleware
from app.db.session import dispose_engine
from app.events import nats_publisher
from app.grpc.forecast_explanation_data_grpc_server import ForecastExplanationDataServicer
from app.grpc.forecast_grpc_server import ForecastServicer
from app.grpc.generated import forecast_explanation_data_pb2_grpc, forecast_pb2_grpc

configure_logging()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    nc = await nats_publisher.connect(settings)
    js: JetStreamContext = nc.jetstream()
    await nats_publisher.bootstrap_stream(js, settings)
    app.state.nats_connection = nc
    app.state.jetstream = js

    grpc_server = grpc.aio.server()
    forecast_pb2_grpc.add_ForecastServiceServicer_to_server(ForecastServicer(), grpc_server)
    # Module 10 Phase 4 (docs/adr/0119) - second servicer, same process/port:
    # a plain join of ForecastRun/ForecastModel/ForecastAccuracyLog by id, no
    # CPU-bound ML work either.
    forecast_explanation_data_pb2_grpc.add_ForecastExplanationDataServiceServicer_to_server(
        ForecastExplanationDataServicer(), grpc_server
    )
    grpc_server.add_insecure_port(settings.grpc_url)
    await grpc_server.start()
    try:
        yield
    finally:
        await grpc_server.stop(grace=5)
        await nc.close()
        await dispose_engine()


app = FastAPI(title="AGNO WFM Forecasting Service", version="0.1.0", lifespan=lifespan)

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
# that needs a preflight at all.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in get_settings().cors_origin.split(",")],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health_router)
app.include_router(jobs_router)
app.include_router(actuals_router)
app.include_router(queue_profiles_router)
app.include_router(data_quality_router)
app.include_router(models_router)
app.include_router(service_level_targets_router)
app.include_router(allocations_router)
app.include_router(backlog_age_templates_router)
app.include_router(backlog_snapshots_router)
app.include_router(campaigns_router)
app.include_router(cc_queues_router)
app.include_router(queue_analytics_router)
app.include_router(scenarios_router)
app.include_router(special_events_router)
app.include_router(accuracy_router)
app.include_router(admin_router)


@app.exception_handler(DomainError)
async def handle_domain_error(_request: Request, exc: DomainError) -> JSONResponse:
    return domain_error_response(exc)


@app.get("/metrics")
async def metrics() -> Response:
    return render_metrics()
