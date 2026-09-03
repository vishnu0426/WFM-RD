from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable
from typing import ClassVar as _ClassVar, Optional as _Optional

DESCRIPTOR: _descriptor.FileDescriptor

class ListPublishedShiftAssignmentsRequest(_message.Message):
    __slots__ = ("tenant_id", "employee_ids", "window_start", "window_end")
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    EMPLOYEE_IDS_FIELD_NUMBER: _ClassVar[int]
    WINDOW_START_FIELD_NUMBER: _ClassVar[int]
    WINDOW_END_FIELD_NUMBER: _ClassVar[int]
    tenant_id: str
    employee_ids: _containers.RepeatedScalarFieldContainer[str]
    window_start: str
    window_end: str
    def __init__(self, tenant_id: _Optional[str] = ..., employee_ids: _Optional[_Iterable[str]] = ..., window_start: _Optional[str] = ..., window_end: _Optional[str] = ...) -> None: ...

class ShiftAssignmentRecord(_message.Message):
    __slots__ = ("employee_id", "schedule_id", "shift_start", "shift_end", "is_overtime")
    EMPLOYEE_ID_FIELD_NUMBER: _ClassVar[int]
    SCHEDULE_ID_FIELD_NUMBER: _ClassVar[int]
    SHIFT_START_FIELD_NUMBER: _ClassVar[int]
    SHIFT_END_FIELD_NUMBER: _ClassVar[int]
    IS_OVERTIME_FIELD_NUMBER: _ClassVar[int]
    employee_id: str
    schedule_id: str
    shift_start: str
    shift_end: str
    is_overtime: bool
    def __init__(self, employee_id: _Optional[str] = ..., schedule_id: _Optional[str] = ..., shift_start: _Optional[str] = ..., shift_end: _Optional[str] = ..., is_overtime: _Optional[bool] = ...) -> None: ...
