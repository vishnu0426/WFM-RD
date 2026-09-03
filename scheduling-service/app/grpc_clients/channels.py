"""Process-wide gRPC channel singletons, mirroring `app/db/session.py`'s
`AsyncEngine` singleton pattern - a `grpc.aio.Channel` is meant to be
long-lived and reused across calls, not opened per-request.
"""

from __future__ import annotations

import grpc

from app.config import Settings, get_settings

_core_channel: grpc.aio.Channel | None = None
_forecasting_channel: grpc.aio.Channel | None = None
_attendance_channel: grpc.aio.Channel | None = None
_compliance_channel: grpc.aio.Channel | None = None


def get_core_channel(settings: Settings | None = None) -> grpc.aio.Channel:
    global _core_channel
    if _core_channel is None:
        settings = settings or get_settings()
        _core_channel = grpc.aio.insecure_channel(settings.core_grpc_url)
    return _core_channel


def get_forecasting_channel(settings: Settings | None = None) -> grpc.aio.Channel:
    global _forecasting_channel
    if _forecasting_channel is None:
        settings = settings or get_settings()
        _forecasting_channel = grpc.aio.insecure_channel(settings.forecasting_grpc_url)
    return _forecasting_channel


def get_attendance_channel(settings: Settings | None = None) -> grpc.aio.Channel:
    """Module 06 Phase 5 (ADR-0078) - reaches `LeaveService.GetUnavailability`."""
    global _attendance_channel
    if _attendance_channel is None:
        settings = settings or get_settings()
        _attendance_channel = grpc.aio.insecure_channel(settings.attendance_grpc_url)
    return _attendance_channel


def get_compliance_channel(settings: Settings | None = None) -> grpc.aio.Channel:
    """Module 08 (docs/adr/0102) - reaches `ComplianceRuleService.GetActiveRule`."""
    global _compliance_channel
    if _compliance_channel is None:
        settings = settings or get_settings()
        _compliance_channel = grpc.aio.insecure_channel(settings.compliance_grpc_url)
    return _compliance_channel


async def close_channels() -> None:
    global _core_channel, _forecasting_channel, _attendance_channel, _compliance_channel
    if _core_channel is not None:
        await _core_channel.close()
    if _forecasting_channel is not None:
        await _forecasting_channel.close()
    if _attendance_channel is not None:
        await _attendance_channel.close()
    if _compliance_channel is not None:
        await _compliance_channel.close()
    _core_channel = None
    _forecasting_channel = None
    _attendance_channel = None
    _compliance_channel = None
