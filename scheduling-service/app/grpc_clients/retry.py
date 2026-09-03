"""§4.3/ADR-0059's retry policy: "a transient gRPC failure mid-solve should
retry the specific data call, not abort the whole solve job." Shared by
every client in this package - one place to get the retryable-status-code
set and backoff schedule right, rather than three independent copies.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import TypeVar

import grpc

# Genuinely transient - the server (or the network path to it) is
# temporarily unavailable/slow. Never `INVALID_ARGUMENT`/`NOT_FOUND`/etc. -
# a retry cannot fix a malformed request or a request for something that
# doesn't exist.
_RETRYABLE_CODES = frozenset({grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED})

# 1 initial attempt + 3 retries, backoff between them - matches §4.3's own
# instruction to retry "the specific data call," bounded so a genuinely-down
# upstream fails this request in a few seconds, not indefinitely.
_BACKOFF_SECONDS = (0.1, 0.4, 1.6)

_T = TypeVar("_T")


class GrpcCallExhaustedError(Exception):
    """Every retry attempt failed with a retryable status - the caller maps
    this to a domain-level `UpstreamDataUnavailableError` (503) rather than
    letting a raw gRPC exception surface as an opaque 500."""

    def __init__(self, service: str, method: str, last_error: grpc.aio.AioRpcError) -> None:
        self.service = service
        self.method = method
        self.last_error = last_error
        super().__init__(
            f"{service}.{method} failed after {len(_BACKOFF_SECONDS) + 1} attempts: "
            f"{last_error.code()} {last_error.details()}"
        )


async def call_with_retry(
    service: str, method: str, call: Callable[[], Awaitable[_T]]
) -> _T:
    last_error: grpc.aio.AioRpcError | None = None
    for delay in (0.0, *_BACKOFF_SECONDS):
        if delay:
            await asyncio.sleep(delay)
        try:
            return await call()
        except grpc.aio.AioRpcError as exc:
            if exc.code() not in _RETRYABLE_CODES:
                raise
            last_error = exc
    assert last_error is not None  # the loop always runs at least once
    raise GrpcCallExhaustedError(service, method, last_error)
