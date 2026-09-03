from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class GetForecastRequirementsRequest(_message.Message):
    __slots__ = ("tenant_id", "forecast_run_id")
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    FORECAST_RUN_ID_FIELD_NUMBER: _ClassVar[int]
    tenant_id: str
    forecast_run_id: str
    def __init__(self, tenant_id: _Optional[str] = ..., forecast_run_id: _Optional[str] = ...) -> None: ...

class GetForecastRequirementsResponse(_message.Message):
    __slots__ = ("found", "requirements")
    FOUND_FIELD_NUMBER: _ClassVar[int]
    REQUIREMENTS_FIELD_NUMBER: _ClassVar[int]
    found: bool
    requirements: _containers.RepeatedCompositeFieldContainer[ForecastRequirement]
    def __init__(self, found: _Optional[bool] = ..., requirements: _Optional[_Iterable[_Union[ForecastRequirement, _Mapping]]] = ...) -> None: ...

class ForecastRequirement(_message.Message):
    __slots__ = ("interval_start", "interval_minutes", "required_headcount")
    INTERVAL_START_FIELD_NUMBER: _ClassVar[int]
    INTERVAL_MINUTES_FIELD_NUMBER: _ClassVar[int]
    REQUIRED_HEADCOUNT_FIELD_NUMBER: _ClassVar[int]
    interval_start: str
    interval_minutes: int
    required_headcount: str
    def __init__(self, interval_start: _Optional[str] = ..., interval_minutes: _Optional[int] = ..., required_headcount: _Optional[str] = ...) -> None: ...
