from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class GetForecastRunForExplanationRequest(_message.Message):
    __slots__ = ("tenant_id", "forecast_run_id")
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    FORECAST_RUN_ID_FIELD_NUMBER: _ClassVar[int]
    tenant_id: str
    forecast_run_id: str
    def __init__(self, tenant_id: _Optional[str] = ..., forecast_run_id: _Optional[str] = ...) -> None: ...

class GetForecastRunForExplanationResponse(_message.Message):
    __slots__ = ("found", "tenant_id", "org_unit_id", "status", "date_range_start", "date_range_end", "interval_minutes", "is_cold_start", "completed_at", "has_model", "model_type", "model_status", "backtest_mape", "backtest_wfa", "minimum_data_volume_met", "accuracy_log")
    FOUND_FIELD_NUMBER: _ClassVar[int]
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    ORG_UNIT_ID_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    DATE_RANGE_START_FIELD_NUMBER: _ClassVar[int]
    DATE_RANGE_END_FIELD_NUMBER: _ClassVar[int]
    INTERVAL_MINUTES_FIELD_NUMBER: _ClassVar[int]
    IS_COLD_START_FIELD_NUMBER: _ClassVar[int]
    COMPLETED_AT_FIELD_NUMBER: _ClassVar[int]
    HAS_MODEL_FIELD_NUMBER: _ClassVar[int]
    MODEL_TYPE_FIELD_NUMBER: _ClassVar[int]
    MODEL_STATUS_FIELD_NUMBER: _ClassVar[int]
    BACKTEST_MAPE_FIELD_NUMBER: _ClassVar[int]
    BACKTEST_WFA_FIELD_NUMBER: _ClassVar[int]
    MINIMUM_DATA_VOLUME_MET_FIELD_NUMBER: _ClassVar[int]
    ACCURACY_LOG_FIELD_NUMBER: _ClassVar[int]
    found: bool
    tenant_id: str
    org_unit_id: str
    status: str
    date_range_start: str
    date_range_end: str
    interval_minutes: int
    is_cold_start: bool
    completed_at: str
    has_model: bool
    model_type: str
    model_status: str
    backtest_mape: str
    backtest_wfa: str
    minimum_data_volume_met: bool
    accuracy_log: _containers.RepeatedCompositeFieldContainer[ForecastAccuracyEntry]
    def __init__(self, found: _Optional[bool] = ..., tenant_id: _Optional[str] = ..., org_unit_id: _Optional[str] = ..., status: _Optional[str] = ..., date_range_start: _Optional[str] = ..., date_range_end: _Optional[str] = ..., interval_minutes: _Optional[int] = ..., is_cold_start: _Optional[bool] = ..., completed_at: _Optional[str] = ..., has_model: _Optional[bool] = ..., model_type: _Optional[str] = ..., model_status: _Optional[str] = ..., backtest_mape: _Optional[str] = ..., backtest_wfa: _Optional[str] = ..., minimum_data_volume_met: _Optional[bool] = ..., accuracy_log: _Optional[_Iterable[_Union[ForecastAccuracyEntry, _Mapping]]] = ...) -> None: ...

class ForecastAccuracyEntry(_message.Message):
    __slots__ = ("evaluated_at", "actual_volume", "predicted_volume", "mape", "bias")
    EVALUATED_AT_FIELD_NUMBER: _ClassVar[int]
    ACTUAL_VOLUME_FIELD_NUMBER: _ClassVar[int]
    PREDICTED_VOLUME_FIELD_NUMBER: _ClassVar[int]
    MAPE_FIELD_NUMBER: _ClassVar[int]
    BIAS_FIELD_NUMBER: _ClassVar[int]
    evaluated_at: str
    actual_volume: str
    predicted_volume: str
    mape: str
    bias: str
    def __init__(self, evaluated_at: _Optional[str] = ..., actual_volume: _Optional[str] = ..., predicted_volume: _Optional[str] = ..., mape: _Optional[str] = ..., bias: _Optional[str] = ...) -> None: ...
