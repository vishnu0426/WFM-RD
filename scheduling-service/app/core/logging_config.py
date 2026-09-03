"""§8's structured-logging requirement, applied to this service for the
first time in Phase 7/8. JSON lines, one per log record - `app/worker.py`
calls this at startup since it has no HTTP request to attach context to the
way `TenantContextMiddleware` could; `app/main.py` calls it too for
consistency, matching `forecasting-service/app/core/logging_config.py`'s
own precedent (that one is request-specific; this one is general-purpose
since a worker process has no requests at all).
"""

from __future__ import annotations

import json
import logging
from typing import Any


def configure_logging() -> None:
    root = logging.getLogger()
    if root.handlers:
        return  # idempotent - re-importing this module must not double-attach handlers
    handler = logging.StreamHandler()
    handler.setFormatter(_JsonFormatter())
    root.addHandler(handler)
    root.setLevel(logging.INFO)


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        extra_fields = getattr(record, "fields", None)
        if extra_fields:
            payload.update(extra_fields)
        return json.dumps(payload)
