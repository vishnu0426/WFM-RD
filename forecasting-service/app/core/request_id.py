"""§3.3's cross-cutting `X-Request-Id` requirement: echoes a caller-supplied
id, generates one otherwise, and stamps it on the response so client and
service logs can be correlated - no shared code to reuse from Module 01/02
(neither has a REST surface yet), so this is a first cut, same posture
ADR-0015 took for the error envelope.
"""

from __future__ import annotations

import uuid

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

REQUEST_ID_HEADER = "X-Request-Id"


class RequestIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        request_id = request.headers.get(REQUEST_ID_HEADER, str(uuid.uuid4()))
        request.state.request_id = request_id
        response = await call_next(request)
        response.headers[REQUEST_ID_HEADER] = request_id
        return response
