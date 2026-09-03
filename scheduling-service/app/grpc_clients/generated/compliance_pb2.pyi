from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable
from typing import ClassVar as _ClassVar, Optional as _Optional

DESCRIPTOR: _descriptor.FileDescriptor

class GetActiveRuleRequest(_message.Message):
    __slots__ = ("tenant_id", "jurisdiction", "rule_type", "as_of")
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    JURISDICTION_FIELD_NUMBER: _ClassVar[int]
    RULE_TYPE_FIELD_NUMBER: _ClassVar[int]
    AS_OF_FIELD_NUMBER: _ClassVar[int]
    tenant_id: str
    jurisdiction: str
    rule_type: str
    as_of: str
    def __init__(self, tenant_id: _Optional[str] = ..., jurisdiction: _Optional[str] = ..., rule_type: _Optional[str] = ..., as_of: _Optional[str] = ...) -> None: ...

class ComplianceRuleResponse(_message.Message):
    __slots__ = ("found", "id", "jurisdiction", "rule_type", "definition_json", "effective_from", "effective_to", "version", "citation", "is_platform_default")
    FOUND_FIELD_NUMBER: _ClassVar[int]
    ID_FIELD_NUMBER: _ClassVar[int]
    JURISDICTION_FIELD_NUMBER: _ClassVar[int]
    RULE_TYPE_FIELD_NUMBER: _ClassVar[int]
    DEFINITION_JSON_FIELD_NUMBER: _ClassVar[int]
    EFFECTIVE_FROM_FIELD_NUMBER: _ClassVar[int]
    EFFECTIVE_TO_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    CITATION_FIELD_NUMBER: _ClassVar[int]
    IS_PLATFORM_DEFAULT_FIELD_NUMBER: _ClassVar[int]
    found: bool
    id: str
    jurisdiction: str
    rule_type: str
    definition_json: str
    effective_from: str
    effective_to: str
    version: int
    citation: str
    is_platform_default: bool
    def __init__(self, found: _Optional[bool] = ..., id: _Optional[str] = ..., jurisdiction: _Optional[str] = ..., rule_type: _Optional[str] = ..., definition_json: _Optional[str] = ..., effective_from: _Optional[str] = ..., effective_to: _Optional[str] = ..., version: _Optional[int] = ..., citation: _Optional[str] = ..., is_platform_default: _Optional[bool] = ...) -> None: ...

class ValidatePolicyAgainstFloorRequest(_message.Message):
    __slots__ = ("tenant_id", "jurisdiction", "rule_type", "policy_definition_json")
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    JURISDICTION_FIELD_NUMBER: _ClassVar[int]
    RULE_TYPE_FIELD_NUMBER: _ClassVar[int]
    POLICY_DEFINITION_JSON_FIELD_NUMBER: _ClassVar[int]
    tenant_id: str
    jurisdiction: str
    rule_type: str
    policy_definition_json: str
    def __init__(self, tenant_id: _Optional[str] = ..., jurisdiction: _Optional[str] = ..., rule_type: _Optional[str] = ..., policy_definition_json: _Optional[str] = ...) -> None: ...

class ValidatePolicyAgainstFloorResponse(_message.Message):
    __slots__ = ("valid", "violations", "floor_not_found")
    VALID_FIELD_NUMBER: _ClassVar[int]
    VIOLATIONS_FIELD_NUMBER: _ClassVar[int]
    FLOOR_NOT_FOUND_FIELD_NUMBER: _ClassVar[int]
    valid: bool
    violations: _containers.RepeatedScalarFieldContainer[str]
    floor_not_found: bool
    def __init__(self, valid: _Optional[bool] = ..., violations: _Optional[_Iterable[str]] = ..., floor_not_found: _Optional[bool] = ...) -> None: ...
