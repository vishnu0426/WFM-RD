"""§8's HTTP-level metrics for this process (the FastAPI app, not the
worker - see `app/core/worker_metrics.py` for that one). `prometheus-client`,
mirroring `forecasting-service/app/core/metrics.py`'s own established
pattern. `route` labels are the matched route *template*
(`/v1/scheduling/jobs/{job_id}`), never the raw path - the same
bounded-cardinality requirement Module 01's `http-metrics.interceptor.ts`
and `forecasting-service`'s own copy of this file both already state (a
job/schedule UUID in every raw path would make the label cardinality
unbounded).
"""

from __future__ import annotations

import time

from prometheus_client import (
    CONTENT_TYPE_LATEST,
    CollectorRegistry,
    Counter,
    Gauge,
    Histogram,
    generate_latest,
)
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

from app.db.session import get_session_factory
from app.services import queue_service

REGISTRY = CollectorRegistry()

REQUEST_DURATION_SECONDS = Histogram(
    "http_request_duration_seconds",
    "HTTP request duration in seconds.",
    ["method", "route", "status_code"],
    registry=REGISTRY,
)
REQUEST_COUNT = Counter(
    "http_requests_total",
    "Total HTTP requests.",
    ["method", "route", "status_code"],
    registry=REGISTRY,
)
# §8's queue-depth metric - refreshed live on every `/metrics` scrape
# (`render_metrics`, below), not pushed by `app.worker` (a separate OS
# process whose own in-memory registry this one can never see - see
# `app/core/worker_metrics.py`'s module docstring). A `Gauge`, not a
# `Counter`: this is a point-in-time snapshot, not a running total.
QUEUE_DEPTH = Gauge(
    "scheduling_queue_depth",
    "Jobs currently queued or solving, across every tenant.",
    ["status"],
    registry=REGISTRY,
)

_UNMATCHED_ROUTE = "unmatched"


class MetricsMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        start = time.perf_counter()
        response = await call_next(request)
        route = request.scope.get("route")
        route_label = route.path if route is not None else _UNMATCHED_ROUTE
        if route_label != "/metrics":
            duration = time.perf_counter() - start
            labels = {
                "method": request.method,
                "route": route_label,
                "status_code": str(response.status_code),
            }
            REQUEST_DURATION_SECONDS.labels(**labels).observe(duration)
            REQUEST_COUNT.labels(**labels).inc()
        return response


async def render_metrics() -> Response:
    depth = await queue_service.get_queue_depth(get_session_factory())
    for status, count in depth.items():
        QUEUE_DEPTH.labels(status=status).set(count)
    return Response(content=generate_latest(REGISTRY), media_type=CONTENT_TYPE_LATEST)
