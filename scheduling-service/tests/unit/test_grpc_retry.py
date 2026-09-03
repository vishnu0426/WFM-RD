"""§4.3/ADR-0059's retry policy (`app/grpc_clients/retry.py`): "a transient
gRPC failure mid-solve should retry the specific data call, not abort the
whole solve job." Proven against real `grpc.aio.AioRpcError` instances (the
actual exception type a real channel raises), not a hand-rolled stand-in -
`asyncio.sleep` is monkeypatched so this suite runs instantly rather than
waiting out the real backoff schedule.
"""

from __future__ import annotations

import grpc
import pytest

from app.grpc_clients.retry import GrpcCallExhaustedError, call_with_retry


def _error(code: grpc.StatusCode) -> grpc.aio.AioRpcError:
    return grpc.aio.AioRpcError(code, details=f"synthetic {code}")


@pytest.fixture(autouse=True)
def _no_real_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _instant_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr("app.grpc_clients.retry.asyncio.sleep", _instant_sleep)


async def test_succeeds_immediately_with_no_retry_needed() -> None:
    calls = 0

    async def call() -> str:
        nonlocal calls
        calls += 1
        return "ok"

    result = await call_with_retry("Svc", "Method", call)
    assert result == "ok"
    assert calls == 1


async def test_retries_on_unavailable_and_eventually_succeeds() -> None:
    calls = 0

    async def call() -> str:
        nonlocal calls
        calls += 1
        if calls < 3:
            raise _error(grpc.StatusCode.UNAVAILABLE)
        return "ok"

    result = await call_with_retry("Svc", "Method", call)
    assert result == "ok"
    assert calls == 3


async def test_retries_on_deadline_exceeded() -> None:
    calls = 0

    async def call() -> str:
        nonlocal calls
        calls += 1
        if calls < 2:
            raise _error(grpc.StatusCode.DEADLINE_EXCEEDED)
        return "ok"

    result = await call_with_retry("Svc", "Method", call)
    assert result == "ok"
    assert calls == 2


async def test_never_retries_a_non_transient_error() -> None:
    calls = 0

    async def call() -> str:
        nonlocal calls
        calls += 1
        raise _error(grpc.StatusCode.INVALID_ARGUMENT)

    with pytest.raises(grpc.aio.AioRpcError) as exc_info:
        await call_with_retry("Svc", "Method", call)
    assert exc_info.value.code() == grpc.StatusCode.INVALID_ARGUMENT
    assert calls == 1


async def test_exhausting_every_retry_raises_grpc_call_exhausted_error() -> None:
    calls = 0

    async def call() -> str:
        nonlocal calls
        calls += 1
        raise _error(grpc.StatusCode.UNAVAILABLE)

    with pytest.raises(GrpcCallExhaustedError) as exc_info:
        await call_with_retry("EmployeeService", "GetSchedulableEmployees", call)
    assert calls == 4  # 1 initial + 3 retries
    assert exc_info.value.service == "EmployeeService"
    assert exc_info.value.method == "GetSchedulableEmployees"
    assert exc_info.value.last_error.code() == grpc.StatusCode.UNAVAILABLE
