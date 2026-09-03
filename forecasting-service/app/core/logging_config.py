"""ADR-0026, Decision 7 - structured JSON request logging, a first cut for
the platform (Module 01/02 have no structured-logging precedent to match -
plain `Logger` text, confirmed by inspection - so this isn't a divergence
from an established convention). One JSON line per request, emitted from
`TenantContextMiddleware` itself rather than a separate middleware layer -
see that module's docstring for why (an outer middleware logging after
`call_next()` returns would see the tenant context already unbound).
"""

from __future__ import annotations

import json
import logging
from typing import Any

_LOGGER_NAME = "agno.forecasting.request"


def configure_logging() -> None:
    logger = logging.getLogger(_LOGGER_NAME)
    if logger.handlers:
        return  # idempotent - re-importing this module must not double-attach handlers
    handler = logging.StreamHandler()
    handler.setFormatter(_JsonFormatter())
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "message": record.getMessage(),
        }
        payload.update(getattr(record, "fields", {}))
        return json.dumps(payload)


def log_request(
    *,
    method: str,
    path: str,
    status_code: int,
    duration_ms: float,
    request_id: str | None,
    tenant_id: str | None,
) -> None:
    logger = logging.getLogger(_LOGGER_NAME)
    logger.info(
        "request completed",
        extra={
            "fields": {
                "method": method,
                "path": path,
                "statusCode": status_code,
                "durationMs": round(duration_ms, 2),
                "requestId": request_id,
                "tenantId": tenant_id,
            }
        },
    )
