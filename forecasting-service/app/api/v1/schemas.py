"""Request/response models for §3.3's REST job contract. Field names match
§2.1's `ForecastRun` entity and §3.3's request shape (`tenantId`, `orgUnitId`,
`dateRange`, `intervalMinutes`) directly - `populate_by_name` + camelCase
aliases so the wire format matches the rest of the platform's convention
(GraphQL/TypeScript camelCase) without forcing camelCase Python attribute
names.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, time
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


def _to_camel(field_name: str) -> str:
    first, *rest = field_name.split("_")
    return first + "".join(word.capitalize() for word in rest)


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=_to_camel, populate_by_name=True)


class DateRange(CamelModel):
    start: date
    end: date


class ForecastJobRequest(CamelModel):
    org_unit_id: uuid.UUID
    date_range: DateRange
    interval_minutes: int = Field(gt=0)


class ForecastJobResponse(CamelModel):
    job_id: uuid.UUID
    status: str


class ForecastRunDetail(CamelModel):
    id: uuid.UUID
    tenant_id: uuid.UUID
    org_unit_id: uuid.UUID
    forecast_model_id: uuid.UUID | None
    date_range: DateRange
    interval_minutes: int
    status: str
    is_cold_start: bool
    requested_at: datetime
    completed_at: datetime | None


class ForecastDataPointResponse(CamelModel):
    interval_start: datetime
    predicted_volume: Decimal | None
    predicted_aht_seconds: Decimal | None
    predicted_shrinkage_pct: Decimal | None
    confidence_lower: Decimal | None
    confidence_upper: Decimal | None
    required_headcount: Decimal | None


class ActualPointRequest(CamelModel):
    interval_start: datetime
    actual_volume: Decimal | None = None
    actual_aht_seconds: Decimal | None = None
    actual_shrinkage_pct: Decimal | None = None


class IngestActualsRequest(CamelModel):
    org_unit_id: uuid.UUID
    points: list[ActualPointRequest] = Field(min_length=1)


class IngestActualsResponse(CamelModel):
    ingested: int
    accuracy_logged: int


class QueueProfileRequest(CamelModel):
    industry: str = Field(min_length=1, max_length=64)
    queue_type: str = Field(min_length=1, max_length=64)
    expected_volume_band: str = Field(pattern="^(xs|s|m|l|xl)$")
    timezone_bucket: str = Field(min_length=1, max_length=64)


class QueueProfileResponse(QueueProfileRequest):
    org_unit_id: uuid.UUID


class CcQueueRequest(CamelModel):
    org_unit_id: uuid.UUID
    external_queue_id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=100)
    acd_provider: str | None = Field(default=None, max_length=32)
    channel: str = Field(default="voice", pattern="^(voice|chat|email|sms|social)$")
    routing_config: dict[str, object] = Field(default_factory=dict)
    status: str = Field(default="active", pattern="^(active|inactive)$")


class CcQueueResponse(CcQueueRequest):
    id: uuid.UUID


class DataQualityCheckResponse(CamelModel):
    id: uuid.UUID
    org_unit_id: uuid.UUID
    model_type: str
    target_metric: str
    passed: bool
    failure_reason: str | None
    total_expected_intervals: int
    missing_intervals: int
    evaluated_at: datetime


class RetrainRequest(CamelModel):
    target_metric: str = Field(default="volume", pattern="^(volume|aht|shrinkage)$")
    interval_minutes: int = Field(default=30, gt=0)
    # ADR-0026: omitting this keeps the exact pre-Phase-8 default (sarima/
    # prophet/lightgbm, unconditionally) - `tft` is only ever attempted when
    # explicitly listed here.
    model_types: list[Literal["sarima", "prophet", "lightgbm", "tft"]] | None = Field(
        default=None, min_length=1
    )


class RetrainOutcomeResponse(CamelModel):
    model_type: str
    trained: bool
    reason: str | None
    forecast_model_id: uuid.UUID | None
    backtest_mape: float | None
    backtest_wfa: float | None
    status: str | None


class RetrainResponse(CamelModel):
    org_unit_id: uuid.UUID
    outcomes: list[RetrainOutcomeResponse]


class ForecastModelResponse(CamelModel):
    id: uuid.UUID
    org_unit_id: uuid.UUID
    model_type: str
    target_metric: str
    trained_at: datetime | None
    backtest_mape: Decimal | None
    backtest_wfa: Decimal | None
    status: str
    artifact_uri: str | None
    training_data_window_start: datetime | None
    training_data_window_end: datetime | None
    minimum_data_volume_met: bool


class ServiceLevelTargetRequest(CamelModel):
    target_service_level: Decimal = Field(gt=0, le=1)
    target_answer_time_seconds: int = Field(gt=0)
    max_occupancy: Decimal = Field(gt=0, le=1)


class ServiceLevelTargetResponse(ServiceLevelTargetRequest):
    org_unit_id: uuid.UUID
    is_default: bool


class AllocationEntry(CamelModel):
    skill_id: uuid.UUID
    allocation_percentage: Decimal = Field(gt=0, le=100)


class ReplaceAllocationsRequest(CamelModel):
    allocations: list[AllocationEntry]

    @model_validator(mode="after")
    def _sums_to_100(self) -> ReplaceAllocationsRequest:
        if not self.allocations:
            raise ValueError("allocations must not be empty")
        skill_ids = [a.skill_id for a in self.allocations]
        if len(skill_ids) != len(set(skill_ids)):
            raise ValueError("allocations must not repeat the same skill")
        total = sum(a.allocation_percentage for a in self.allocations)
        # A small tolerance for rounding (percentages are numeric(5,2)),
        # not a loose validation - mirrors the fixed-point tolerance
        # `DateRange`/other boundary validators use elsewhere.
        if abs(total - Decimal("100")) > Decimal("0.05"):
            raise ValueError("allocations must sum to 100%")
        return self


class AllocationsResponse(CamelModel):
    org_unit_id: uuid.UUID
    allocations: list[AllocationEntry]


class ScenarioAssumptionOverridesRequest(CamelModel):
    volume_multiplier: Decimal = Field(default=Decimal("1"), ge=0)
    aht_delta_seconds: Decimal = Field(default=Decimal("0"))
    shrinkage_delta_pct: Decimal = Field(default=Decimal("0"), ge=-1, le=1)


class CreateScenarioRequest(CamelModel):
    base_forecast_run_id: uuid.UUID
    assumption_overrides: ScenarioAssumptionOverridesRequest = Field(
        default_factory=ScenarioAssumptionOverridesRequest
    )


class ScenarioSimulationResponse(CamelModel):
    id: uuid.UUID
    base_forecast_run_id: uuid.UUID
    assumption_overrides: dict[str, object]
    result_forecast_run_id: uuid.UUID | None
    status: str


class SpecialEventRequest(CamelModel):
    org_unit_id: uuid.UUID | None = None
    event_type: str = Field(pattern="^(holiday|marketing_campaign|product_launch|anomaly_flagged)$")
    date_range: DateRange
    expected_volume_multiplier: Decimal | None = Field(default=None, gt=0)


class SpecialEventResponse(CamelModel):
    id: uuid.UUID
    org_unit_id: uuid.UUID | None
    event_type: str
    date_range: DateRange
    expected_volume_multiplier: Decimal | None
    tagged_by: uuid.UUID | None


class StalenessResponse(CamelModel):
    org_unit_id: uuid.UUID
    has_active_model: bool
    active_model_id: uuid.UUID | None
    trained_at: datetime | None
    age_hours: float | None
    age_stale: bool | None
    backtest_mape: float | None
    recent_avg_mape: float | None
    sample_size: int
    accuracy_degraded: bool | None
    insufficient_accuracy_data: bool
    retrain_recommended: bool


class AccuracyTrendPoint(CamelModel):
    forecast_run_id: uuid.UUID
    evaluated_at: datetime
    actual_volume: Decimal
    predicted_volume: Decimal
    mape: Decimal | None
    bias: Decimal | None


class AccuracyTrendResponse(CamelModel):
    org_unit_id: uuid.UUID
    points: list[AccuracyTrendPoint]


class TenantSettingsRequest(CamelModel):
    tft_entitled: bool = False
    cold_start_cross_tenant_matching_enabled: bool = False


class TenantSettingsResponse(TenantSettingsRequest):
    tenant_id: uuid.UUID


class FeatureImportance(CamelModel):
    feature: str
    importance: float


class ModelProvenanceResponse(CamelModel):
    org_unit_id: uuid.UUID
    target_metric: str
    active_model_id: uuid.UUID | None
    history: list[ForecastModelResponse]
    feature_importances: list[FeatureImportance] | None


# ---- Backlog age templates ("Backlog Age Template" in the reference console's own menu) ----


class BacklogAgeTemplateRequest(CamelModel):
    name: str = Field(min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=500)
    warning_threshold_minutes: int = Field(gt=0)
    critical_threshold_minutes: int = Field(gt=0)

    @model_validator(mode="after")
    def _critical_after_warning(self) -> BacklogAgeTemplateRequest:
        if self.critical_threshold_minutes <= self.warning_threshold_minutes:
            raise ValueError("criticalThresholdMinutes must be greater than warningThresholdMinutes")
        return self


class BacklogAgeTemplateResponse(BacklogAgeTemplateRequest):
    id: uuid.UUID


class BacklogAgeTemplateUpdateRequest(CamelModel):
    """PATCH semantics - unset fields left unchanged. The critical-after-
    warning invariant is re-checked service-side against the merged final
    state, since a partial update alone can't validate it (e.g. lowering
    just the critical threshold below an unset, already-stored warning
    threshold)."""

    name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=500)
    warning_threshold_minutes: int | None = Field(default=None, gt=0)
    critical_threshold_minutes: int | None = Field(default=None, gt=0)


# ---- Backlog snapshots ("Backlog Age" in the reference console's own menu) ----


class RecordBacklogSnapshotRequest(CamelModel):
    org_unit_id: uuid.UUID
    template_id: uuid.UUID | None = None
    item_count: int = Field(ge=0)
    oldest_item_age_minutes: int = Field(ge=0)


class BacklogSnapshotResponse(CamelModel):
    id: uuid.UUID
    org_unit_id: uuid.UUID
    template_id: uuid.UUID | None
    item_count: int
    oldest_item_age_minutes: int
    recorded_at: datetime


# ---- Campaigns ("Campaigns" > "Settings" in the reference console's own menu) ----


class CampaignRequest(CamelModel):
    name: str = Field(min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=500)
    status: str = Field(default="draft", pattern="^(draft|active|paused|completed)$")
    start_date: date | None = None
    end_date: date | None = None
    time_zone: str | None = Field(default=None, max_length=64)
    week_start_day: str | None = Field(
        default=None, pattern="^(SUNDAY|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY)$"
    )
    day_boundary: time | None = None
    is_distributed_campaign: bool = False
    scheduling_period: str | None = Field(default=None, pattern="^(WEEKLY|BIWEEKLY|MONTHLY|CUSTOM)$")

    @model_validator(mode="after")
    def _end_not_before_start(self) -> CampaignRequest:
        if self.start_date and self.end_date and self.end_date < self.start_date:
            raise ValueError("endDate must not be before startDate")
        return self


class CampaignResponse(CampaignRequest):
    id: uuid.UUID


class CampaignUpdateRequest(CamelModel):
    """All fields optional - PATCH semantics (unset = leave unchanged),
    unlike CampaignRequest's create-time shape where every field has a
    real default. Status transitions aren't restricted here; the reference
    spec doesn't define a state machine for this field."""

    name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=500)
    status: str | None = Field(default=None, pattern="^(draft|active|paused|completed)$")
    start_date: date | None = None
    end_date: date | None = None
    time_zone: str | None = Field(default=None, max_length=64)
    week_start_day: str | None = Field(
        default=None, pattern="^(SUNDAY|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY)$"
    )
    day_boundary: time | None = None
    is_distributed_campaign: bool | None = None
    scheduling_period: str | None = Field(default=None, pattern="^(WEEKLY|BIWEEKLY|MONTHLY|CUSTOM)$")


# ---- Campaign queues ("Campaigns" > "Queues" in the reference console's own menu) ----


class AddCampaignQueueRequest(CamelModel):
    org_unit_id: uuid.UUID


class CampaignQueueResponse(CamelModel):
    org_unit_id: uuid.UUID
    added_at: datetime


# ---- Queue analytics ("Queue Analytics" under Workforce Analytics in the reference console's own menu) ----
# A read-only aggregation of signals this platform already has for a queue
# (org unit) - no new domain model, since `QueueProfile`'s own doc comment
# already establishes org units as queues here. Deliberately doesn't invent
# real-time occupancy/AHT/abandon-rate metrics this platform has no live
# telephony signal for.


class QueueAnalyticsAccuracySummary(CamelModel):
    point_count: int
    avg_mape: Decimal | None
    latest_evaluated_at: datetime | None
    latest_actual_volume: Decimal | None
    latest_predicted_volume: Decimal | None


class QueueAnalyticsBacklog(CamelModel):
    item_count: int
    oldest_item_age_minutes: int
    recorded_at: datetime
    status: str  # 'ok' | 'warning' | 'critical' | 'unknown' (unknown = no template)


class QueueAnalyticsCampaign(CamelModel):
    id: uuid.UUID
    name: str
    status: str


class QueueAnalyticsResponse(CamelModel):
    org_unit_id: uuid.UUID
    queue_profile: QueueProfileResponse | None
    service_level_target: ServiceLevelTargetResponse
    accuracy: QueueAnalyticsAccuracySummary
    latest_backlog: QueueAnalyticsBacklog | None
    campaigns: list[QueueAnalyticsCampaign]
