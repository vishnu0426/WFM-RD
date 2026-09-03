"""ADR-0026, Decision 7 - `prometheus-client`, the Python equivalent of
Module 01's `prom-client` (`src/common/metrics/metrics.service.ts`).
`route` labels are the matched route *template*
(`/v1/forecasting/jobs/{job_id}`), never the raw path - the same
bounded-cardinality requirement Module 01's `http-metrics.interceptor.ts`
states explicitly (an org-unit/job UUID in every raw path would make the
label cardinality unbounded).
"""

from __future__ import annotations

import time

from prometheus_client import CONTENT_TYPE_LATEST, CollectorRegistry, Counter, Histogram, generate_latest
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

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


def render_metrics() -> Response:
    return Response(content=generate_latest(REGISTRY), media_type=CONTENT_TYPE_LATEST)
