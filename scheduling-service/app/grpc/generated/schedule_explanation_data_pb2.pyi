from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from typing import ClassVar as _ClassVar, Optional as _Optional

DESCRIPTOR: _descriptor.FileDescriptor

class GetScheduleJobForExplanationRequest(_message.Message):
    __slots__ = ("tenant_id", "job_id")
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    JOB_ID_FIELD_NUMBER: _ClassVar[int]
    tenant_id: str
    job_id: str
    def __init__(self, tenant_id: _Optional[str] = ..., job_id: _Optional[str] = ...) -> None: ...

class GetScheduleJobForExplanationResponse(_message.Message):
    __slots__ = ("found", "tenant_id", "status", "org_unit_id", "date_range_start", "date_range_end", "objective_score", "constraint_config_json", "relaxations_applied_json", "decomposition_plan_json", "completed_at")
    FOUND_FIELD_NUMBER: _ClassVar[int]
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    ORG_UNIT_ID_FIELD_NUMBER: _ClassVar[int]
    DATE_RANGE_START_FIELD_NUMBER: _ClassVar[int]
    DATE_RANGE_END_FIELD_NUMBER: _ClassVar[int]
    OBJECTIVE_SCORE_FIELD_NUMBER: _ClassVar[int]
    CONSTRAINT_CONFIG_JSON_FIELD_NUMBER: _ClassVar[int]
    RELAXATIONS_APPLIED_JSON_FIELD_NUMBER: _ClassVar[int]
    DECOMPOSITION_PLAN_JSON_FIELD_NUMBER: _ClassVar[int]
    COMPLETED_AT_FIELD_NUMBER: _ClassVar[int]
    found: bool
    tenant_id: str
    status: str
    org_unit_id: str
    date_range_start: str
    date_range_end: str
    objective_score: str
    constraint_config_json: str
    relaxations_applied_json: str
    decomposition_plan_json: str
    completed_at: str
    def __init__(self, found: _Optional[bool] = ..., tenant_id: _Optional[str] = ..., status: _Optional[str] = ..., org_unit_id: _Optional[str] = ..., date_range_start: _Optional[str] = ..., date_range_end: _Optional[str] = ..., objective_score: _Optional[str] = ..., constraint_config_json: _Optional[str] = ..., relaxations_applied_json: _Optional[str] = ..., decomposition_plan_json: _Optional[str] = ..., completed_at: _Optional[str] = ...) -> None: ...
