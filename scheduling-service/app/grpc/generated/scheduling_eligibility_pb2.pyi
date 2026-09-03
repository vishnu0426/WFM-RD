from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class CheckAssignmentEligibilityRequest(_message.Message):
    __slots__ = ("tenant_id", "candidate_employee_id", "shift_assignment_id", "org_unit_id", "exclude_shift_assignment_id")
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    CANDIDATE_EMPLOYEE_ID_FIELD_NUMBER: _ClassVar[int]
    SHIFT_ASSIGNMENT_ID_FIELD_NUMBER: _ClassVar[int]
    ORG_UNIT_ID_FIELD_NUMBER: _ClassVar[int]
    EXCLUDE_SHIFT_ASSIGNMENT_ID_FIELD_NUMBER: _ClassVar[int]
    tenant_id: str
    candidate_employee_id: str
    shift_assignment_id: str
    org_unit_id: str
    exclude_shift_assignment_id: str
    def __init__(self, tenant_id: _Optional[str] = ..., candidate_employee_id: _Optional[str] = ..., shift_assignment_id: _Optional[str] = ..., org_unit_id: _Optional[str] = ..., exclude_shift_assignment_id: _Optional[str] = ...) -> None: ...

class CheckAssignmentEligibilityResponse(_message.Message):
    __slots__ = ("shift_assignment_found", "eligible", "violations")
    SHIFT_ASSIGNMENT_FOUND_FIELD_NUMBER: _ClassVar[int]
    ELIGIBLE_FIELD_NUMBER: _ClassVar[int]
    VIOLATIONS_FIELD_NUMBER: _ClassVar[int]
    shift_assignment_found: bool
    eligible: bool
    violations: _containers.RepeatedCompositeFieldContainer[EligibilityViolation]
    def __init__(self, shift_assignment_found: _Optional[bool] = ..., eligible: _Optional[bool] = ..., violations: _Optional[_Iterable[_Union[EligibilityViolation, _Mapping]]] = ...) -> None: ...

class EligibilityViolation(_message.Message):
    __slots__ = ("category", "detail")
    CATEGORY_FIELD_NUMBER: _ClassVar[int]
    DETAIL_FIELD_NUMBER: _ClassVar[int]
    category: str
    detail: str
    def __init__(self, category: _Optional[str] = ..., detail: _Optional[str] = ...) -> None: ...
