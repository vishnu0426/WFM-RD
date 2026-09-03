from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable
from typing import ClassVar as _ClassVar, Optional as _Optional

DESCRIPTOR: _descriptor.FileDescriptor

class GetWorkingTimeRulesRequest(_message.Message):
    __slots__ = ("tenant_id", "org_unit_id", "from_date", "to_date")
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    ORG_UNIT_ID_FIELD_NUMBER: _ClassVar[int]
    FROM_DATE_FIELD_NUMBER: _ClassVar[int]
    TO_DATE_FIELD_NUMBER: _ClassVar[int]
    tenant_id: str
    org_unit_id: str
    from_date: str
    to_date: str
    def __init__(self, tenant_id: _Optional[str] = ..., org_unit_id: _Optional[str] = ..., from_date: _Optional[str] = ..., to_date: _Optional[str] = ...) -> None: ...

class WorkingTimeRules(_message.Message):
    __slots__ = ("country_code", "timezone", "holiday_dates", "standard_business_hours_json")
    COUNTRY_CODE_FIELD_NUMBER: _ClassVar[int]
    TIMEZONE_FIELD_NUMBER: _ClassVar[int]
    HOLIDAY_DATES_FIELD_NUMBER: _ClassVar[int]
    STANDARD_BUSINESS_HOURS_JSON_FIELD_NUMBER: _ClassVar[int]
    country_code: str
    timezone: str
    holiday_dates: _containers.RepeatedScalarFieldContainer[str]
    standard_business_hours_json: str
    def __init__(self, country_code: _Optional[str] = ..., timezone: _Optional[str] = ..., holiday_dates: _Optional[_Iterable[str]] = ..., standard_business_hours_json: _Optional[str] = ...) -> None: ...
