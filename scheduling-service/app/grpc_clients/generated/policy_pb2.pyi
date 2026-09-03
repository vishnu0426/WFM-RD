from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from typing import ClassVar as _ClassVar, Optional as _Optional

DESCRIPTOR: _descriptor.FileDescriptor

class GetActivePolicyRequest(_message.Message):
    __slots__ = ("tenant_id", "policy_group_id", "policy_type", "org_unit_id", "as_of")
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    POLICY_GROUP_ID_FIELD_NUMBER: _ClassVar[int]
    POLICY_TYPE_FIELD_NUMBER: _ClassVar[int]
    ORG_UNIT_ID_FIELD_NUMBER: _ClassVar[int]
    AS_OF_FIELD_NUMBER: _ClassVar[int]
    tenant_id: str
    policy_group_id: str
    policy_type: str
    org_unit_id: str
    as_of: str
    def __init__(self, tenant_id: _Optional[str] = ..., policy_group_id: _Optional[str] = ..., policy_type: _Optional[str] = ..., org_unit_id: _Optional[str] = ..., as_of: _Optional[str] = ...) -> None: ...

class PolicyResponse(_message.Message):
    __slots__ = ("found", "id", "policy_group_id", "policy_type", "org_unit_id", "definition_json", "effective_from", "effective_to", "version")
    FOUND_FIELD_NUMBER: _ClassVar[int]
    ID_FIELD_NUMBER: _ClassVar[int]
    POLICY_GROUP_ID_FIELD_NUMBER: _ClassVar[int]
    POLICY_TYPE_FIELD_NUMBER: _ClassVar[int]
    ORG_UNIT_ID_FIELD_NUMBER: _ClassVar[int]
    DEFINITION_JSON_FIELD_NUMBER: _ClassVar[int]
    EFFECTIVE_FROM_FIELD_NUMBER: _ClassVar[int]
    EFFECTIVE_TO_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    found: bool
    id: str
    policy_group_id: str
    policy_type: str
    org_unit_id: str
    definition_json: str
    effective_from: str
    effective_to: str
    version: int
    def __init__(self, found: _Optional[bool] = ..., id: _Optional[str] = ..., policy_group_id: _Optional[str] = ..., policy_type: _Optional[str] = ..., org_unit_id: _Optional[str] = ..., definition_json: _Optional[str] = ..., effective_from: _Optional[str] = ..., effective_to: _Optional[str] = ..., version: _Optional[int] = ...) -> None: ...
