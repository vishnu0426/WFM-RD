from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class GetSchedulableEmployeesRequest(_message.Message):
    __slots__ = ("tenant_id", "org_unit_id", "required_skill_ids", "min_contract_hours_per_week", "page_size")
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    ORG_UNIT_ID_FIELD_NUMBER: _ClassVar[int]
    REQUIRED_SKILL_IDS_FIELD_NUMBER: _ClassVar[int]
    MIN_CONTRACT_HOURS_PER_WEEK_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    tenant_id: str
    org_unit_id: str
    required_skill_ids: _containers.RepeatedScalarFieldContainer[str]
    min_contract_hours_per_week: float
    page_size: int
    def __init__(self, tenant_id: _Optional[str] = ..., org_unit_id: _Optional[str] = ..., required_skill_ids: _Optional[_Iterable[str]] = ..., min_contract_hours_per_week: _Optional[float] = ..., page_size: _Optional[int] = ...) -> None: ...

class SchedulableEmployee(_message.Message):
    __slots__ = ("employee_id", "employee_number", "org_unit_id", "contract_hours_per_week", "employment_type")
    EMPLOYEE_ID_FIELD_NUMBER: _ClassVar[int]
    EMPLOYEE_NUMBER_FIELD_NUMBER: _ClassVar[int]
    ORG_UNIT_ID_FIELD_NUMBER: _ClassVar[int]
    CONTRACT_HOURS_PER_WEEK_FIELD_NUMBER: _ClassVar[int]
    EMPLOYMENT_TYPE_FIELD_NUMBER: _ClassVar[int]
    employee_id: str
    employee_number: str
    org_unit_id: str
    contract_hours_per_week: float
    employment_type: str
    def __init__(self, employee_id: _Optional[str] = ..., employee_number: _Optional[str] = ..., org_unit_id: _Optional[str] = ..., contract_hours_per_week: _Optional[float] = ..., employment_type: _Optional[str] = ...) -> None: ...

class GetEmployeeSkillMatrixRequest(_message.Message):
    __slots__ = ("tenant_id", "employee_ids")
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    EMPLOYEE_IDS_FIELD_NUMBER: _ClassVar[int]
    tenant_id: str
    employee_ids: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, tenant_id: _Optional[str] = ..., employee_ids: _Optional[_Iterable[str]] = ...) -> None: ...

class EmployeeSkillMatrixResponse(_message.Message):
    __slots__ = ("entries",)
    ENTRIES_FIELD_NUMBER: _ClassVar[int]
    entries: _containers.RepeatedCompositeFieldContainer[EmployeeSkillEntry]
    def __init__(self, entries: _Optional[_Iterable[_Union[EmployeeSkillEntry, _Mapping]]] = ...) -> None: ...

class EmployeeSkillEntry(_message.Message):
    __slots__ = ("employee_id", "skill_id", "proficiency_level", "decay_score", "expiry_date")
    EMPLOYEE_ID_FIELD_NUMBER: _ClassVar[int]
    SKILL_ID_FIELD_NUMBER: _ClassVar[int]
    PROFICIENCY_LEVEL_FIELD_NUMBER: _ClassVar[int]
    DECAY_SCORE_FIELD_NUMBER: _ClassVar[int]
    EXPIRY_DATE_FIELD_NUMBER: _ClassVar[int]
    employee_id: str
    skill_id: str
    proficiency_level: str
    decay_score: float
    expiry_date: str
    def __init__(self, employee_id: _Optional[str] = ..., skill_id: _Optional[str] = ..., proficiency_level: _Optional[str] = ..., decay_score: _Optional[float] = ..., expiry_date: _Optional[str] = ...) -> None: ...
