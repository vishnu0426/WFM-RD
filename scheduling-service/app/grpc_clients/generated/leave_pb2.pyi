from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class GetUnavailabilityRequest(_message.Message):
    __slots__ = ("tenant_id", "employee_ids", "date_range_start", "date_range_end")
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    EMPLOYEE_IDS_FIELD_NUMBER: _ClassVar[int]
    DATE_RANGE_START_FIELD_NUMBER: _ClassVar[int]
    DATE_RANGE_END_FIELD_NUMBER: _ClassVar[int]
    tenant_id: str
    employee_ids: _containers.RepeatedScalarFieldContainer[str]
    date_range_start: str
    date_range_end: str
    def __init__(self, tenant_id: _Optional[str] = ..., employee_ids: _Optional[_Iterable[str]] = ..., date_range_start: _Optional[str] = ..., date_range_end: _Optional[str] = ...) -> None: ...

class GetUnavailabilityResponse(_message.Message):
    __slots__ = ("records",)
    RECORDS_FIELD_NUMBER: _ClassVar[int]
    records: _containers.RepeatedCompositeFieldContainer[UnavailabilityRecord]
    def __init__(self, records: _Optional[_Iterable[_Union[UnavailabilityRecord, _Mapping]]] = ...) -> None: ...

class UnavailabilityRecord(_message.Message):
    __slots__ = ("employee_id", "start_date", "end_date", "leave_type_id")
    EMPLOYEE_ID_FIELD_NUMBER: _ClassVar[int]
    START_DATE_FIELD_NUMBER: _ClassVar[int]
    END_DATE_FIELD_NUMBER: _ClassVar[int]
    LEAVE_TYPE_ID_FIELD_NUMBER: _ClassVar[int]
    employee_id: str
    start_date: str
    end_date: str
    leave_type_id: str
    def __init__(self, employee_id: _Optional[str] = ..., start_date: _Optional[str] = ..., end_date: _Optional[str] = ..., leave_type_id: _Optional[str] = ...) -> None: ...
