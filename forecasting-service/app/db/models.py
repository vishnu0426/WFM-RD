"""SQLAlchemy 2.0 declarative models - the Python-side source of truth for
column names/types, mirroring the role `*.entity.ts` files play in Module
01/02 (ADR-0016). The authoritative DDL (RLS, partitioning, grants, triggers)
lives in `migrations/versions/0001_initial_schema.py` and
`0002_phase2_gate_and_cold_start.py`; these models are kept in sync with it
by hand, the same accepted trade-off ADR-0001 made for TypeORM entities vs.
hand-written migrations.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, time
from decimal import Decimal
from typing import Any

from sqlalchemy import Boolean, Date, DateTime, Integer, Numeric, String, Time
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class ForecastModel(Base):
    __tablename__ = "forecast_models"
    __table_args__ = ({"schema": "forecasting"},)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    org_unit_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    model_type: Mapped[str] = mapped_column(String(32), nullable=False)
    target_metric: Mapped[str] = mapped_column(String(16), nullable=False)
    trained_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    backtest_mape: Mapped[Decimal | None] = mapped_column(Numeric(10, 6))
    backtest_wfa: Mapped[Decimal | None] = mapped_column(Numeric(10, 6))
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="training")
    artifact_uri: Mapped[str | None] = mapped_column(String)
    training_data_window_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    training_data_window_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    minimum_data_volume_met: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ForecastRun(Base):
    __tablename__ = "forecast_runs"
    __table_args__ = ({"schema": "forecasting"},)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    org_unit_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    forecast_model_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    date_range_start: Mapped[date] = mapped_column(Date, nullable=False)
    date_range_end: Mapped[date] = mapped_column(Date, nullable=False)
    interval_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="queued")
    is_cold_start: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ForecastDataPoint(Base):
    __tablename__ = "forecast_data_points"
    __table_args__ = ({"schema": "forecasting"},)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    forecast_run_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    interval_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    predicted_volume: Mapped[Decimal | None] = mapped_column(Numeric(14, 4))
    predicted_aht_seconds: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    predicted_shrinkage_pct: Mapped[Decimal | None] = mapped_column(Numeric(6, 4))
    confidence_lower: Mapped[Decimal | None] = mapped_column(Numeric(14, 4))
    confidence_upper: Mapped[Decimal | None] = mapped_column(Numeric(14, 4))
    required_headcount: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class SpecialEvent(Base):
    __tablename__ = "special_events"
    __table_args__ = ({"schema": "forecasting"},)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    org_unit_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    event_type: Mapped[str] = mapped_column(String(32), nullable=False)
    date_range_start: Mapped[date] = mapped_column(Date, nullable=False)
    date_range_end: Mapped[date] = mapped_column(Date, nullable=False)
    expected_volume_multiplier: Mapped[Decimal | None] = mapped_column(Numeric(6, 3))
    tagged_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ForecastAccuracyLog(Base):
    __tablename__ = "forecast_accuracy_log"
    __table_args__ = ({"schema": "forecasting"},)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    forecast_run_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    org_unit_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    actual_volume: Mapped[Decimal] = mapped_column(Numeric(14, 4), nullable=False)
    predicted_volume: Mapped[Decimal] = mapped_column(Numeric(14, 4), nullable=False)
    mape: Mapped[Decimal | None] = mapped_column(Numeric(10, 6))
    bias: Mapped[Decimal | None] = mapped_column(Numeric(10, 6))
    evaluated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)


class ScenarioSimulation(Base):
    __tablename__ = "scenario_simulations"
    __table_args__ = ({"schema": "forecasting"},)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    base_forecast_run_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    assumption_overrides: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    result_forecast_run_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="queued")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class DataQualityCheck(Base):
    """Schema only in Phase 1 - the gate that writes these rows is Phase 2
    (docs/module-03-phase-1-design-doc.md's out-of-scope list, ADR-0019 for
    the concrete thresholds Phase 2's logic will check against)."""

    __tablename__ = "data_quality_checks"
    __table_args__ = ({"schema": "forecasting"},)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    org_unit_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    model_type: Mapped[str] = mapped_column(String(32), nullable=False)
    target_metric: Mapped[str] = mapped_column(String(16), nullable=False)
    passed: Mapped[bool] = mapped_column(Boolean, nullable=False)
    failure_reason: Mapped[str | None] = mapped_column(String(40))
    total_expected_intervals: Mapped[int] = mapped_column(Integer, nullable=False)
    missing_intervals: Mapped[int] = mapped_column(Integer, nullable=False)
    evaluated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class IdempotencyKey(Base):
    __tablename__ = "idempotency_keys"
    __table_args__ = ({"schema": "forecasting"},)

    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    idempotency_key: Mapped[str] = mapped_column(String(255), primary_key=True)
    forecast_run_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class HistoricalActual(Base):
    """Phase 2 (ADR-0020, Gap 1) - the landing table `DataQualityCheck` reads
    from and Phase 3+ model training will read from. Not an ingestion
    pipeline - just the store `POST /v1/forecasting/actuals` writes into."""

    __tablename__ = "historical_actuals"
    __table_args__ = ({"schema": "forecasting"},)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    org_unit_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    interval_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    actual_volume: Mapped[Decimal | None] = mapped_column(Numeric(14, 4))
    actual_aht_seconds: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    actual_shrinkage_pct: Mapped[Decimal | None] = mapped_column(Numeric(6, 4))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class TenantSettings(Base):
    """Phase 2 (ADR-0020, Gap 2) - local stand-in for tenant entitlement
    flags `core.policies` would otherwise hold, since `agno_forecasting_app`
    has no `core` schema access (ADR-0017). SELECT-only grant - no
    application write path in this phase."""

    __tablename__ = "tenant_settings"
    __table_args__ = ({"schema": "forecasting"},)

    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    tft_entitled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    cold_start_cross_tenant_matching_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class QueueProfile(Base):
    """Phase 2 (ADR-0020, Gap 3) - cold-start similarity metadata, local to
    this schema since Module 02 exposes no gRPC field for it yet."""

    __tablename__ = "queue_profiles"
    __table_args__ = ({"schema": "forecasting"},)

    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    org_unit_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    industry: Mapped[str] = mapped_column(String(64), nullable=False)
    queue_type: Mapped[str] = mapped_column(String(64), nullable=False)
    expected_volume_band: Mapped[str] = mapped_column(String(8), nullable=False)
    timezone_bucket: Mapped[str] = mapped_column(String(64), nullable=False)
    # Nullable, additive (0011_cc_queues.py) - see `queue_id` on
    # `ServiceLevelTarget` for why this stays optional rather than replacing
    # `org_unit_id` as the primary key.
    queue_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class CcQueue(Base):
    """The first-class contact-center queue entity the platform was missing:
    a `(tenant_id, external_queue_id)` row mapping a raw ACD-native queue id
    (e.g. `q_billing_us`, as it arrives verbatim through
    `integration-hub-service`'s adapters and lands in `intraday-service`'s
    `ActivityEvent.queueId`/Redis `AgentLiveState.queueId` - both plain
    strings, never validated against anything today) to this platform's own
    `org_unit_id` and a bit of queue-level config (channel, routing_config).

    Deliberately additive, not a replacement for the existing "org unit
    doubles as a queue" convention `QueueProfile`/`Campaign`/`CampaignQueue`
    established (see their own doc comments) - those keep working unchanged.
    `QueueProfile.queue_id`/`ServiceLevelTarget.queue_id` are nullable FKs
    onto this table for tenants that want to pin config to one queue instead
    of the whole org unit. `GET /v1/forecasting/cc-queues/resolve/{external_queue_id}`
    is the intended join point for `intraday-service`/`integration-hub-service`
    to resolve their already-flowing external queue id back to a tenant/org
    unit - no schema change needed on their side, since the value they
    already carry (`external_queue_id`) is exactly this table's natural key.
    """

    __tablename__ = "cc_queues"
    __table_args__ = ({"schema": "forecasting"},)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    org_unit_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    external_queue_id: Mapped[str] = mapped_column(String(128), nullable=False)
    acd_provider: Mapped[str | None] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    channel: Mapped[str] = mapped_column(String(16), nullable=False, default="voice")
    routing_config: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ServiceLevelTarget(Base):
    """Phase 5 (ADR-0023, Decision 3) - Erlang C's business-configuration
    inputs. Tenant-writable, unlike `TenantSettings` - ordinary business
    config, not an admin-gated entitlement. Platform defaults apply in
    `headcount_service.py` when no row exists for an org unit."""

    __tablename__ = "service_level_targets"
    __table_args__ = ({"schema": "forecasting"},)

    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    org_unit_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    target_service_level: Mapped[Decimal] = mapped_column(Numeric(4, 3), nullable=False)
    target_answer_time_seconds: Mapped[int] = mapped_column(Integer, nullable=False)
    max_occupancy: Mapped[Decimal] = mapped_column(Numeric(4, 3), nullable=False)
    # Nullable, additive (0011_cc_queues.py) - lets a target be pinned to one
    # `CcQueue` instead of the whole org unit, without breaking the existing
    # org-unit-keyed rows that predate `CcQueue`.
    queue_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class HeadcountAllocation(Base):
    """Splits an org unit's `ServiceLevelTarget`-derived required headcount
    across skills. One row per (org unit, skill); the full set for an org
    unit is expected to sum to 100% (enforced at the API boundary, not here -
    same trade-off `ServiceLevelTarget`'s bounds checks made)."""

    __tablename__ = "headcount_allocations"
    __table_args__ = ({"schema": "forecasting"},)

    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    org_unit_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    skill_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    allocation_percentage: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class BacklogAgeTemplate(Base):
    """"Backlog Age Template" in the reference console's own menu - a
    reusable, named pair of warning/critical age thresholds (e.g. "Standard
    Email SLA", warn at 240min/critical at 480min), picked when recording or
    reviewing a `BacklogSnapshot` for a given queue (org unit). Tenant-wide
    library, same "named reusable bundle" shape `ShiftTemplate` established
    in the sibling scheduling-service."""

    __tablename__ = "backlog_age_templates"
    __table_args__ = ({"schema": "forecasting"},)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str | None] = mapped_column(String(500))
    warning_threshold_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    critical_threshold_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class BacklogSnapshot(Base):
    """"Backlog Age" in the reference console's own menu - a point-in-time
    reading of how much unprocessed work (and how old the oldest item is)
    sits in a queue (org unit), for async channels with no live telephony
    signal to derive this from automatically. Append-only landing-zone
    shape, same trade-off `HistoricalActual` already made for volume/AHT -
    recorded via the API (manually, or by a future real integration), never
    computed here."""

    __tablename__ = "backlog_snapshots"
    __table_args__ = (
        {"schema": "forecasting"},
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    org_unit_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    template_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    item_count: Mapped[int] = mapped_column(Integer, nullable=False)
    oldest_item_age_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class Campaign(Base):
    """"Campaigns" in the reference console's own menu - a named grouping of
    queues (org units, see `QueueProfile`'s own doc comment for why org
    units double as queues in this platform) worked toward a shared goal
    over a date range (e.g. "Q1 Retention Drive"). No dialer/telephony
    integration exists anywhere in this platform, so this is deliberately
    scoped to what's real: a named container plus its member queues
    (`CampaignQueue`) and status - not outbound dial ratios, pacing, or
    call-list management, none of which this platform has a signal for."""

    __tablename__ = "campaigns"
    __table_args__ = ({"schema": "forecasting"},)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str | None] = mapped_column(String(500))
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="draft")
    start_date: Mapped[date | None] = mapped_column(Date)
    end_date: Mapped[date | None] = mapped_column(Date)
    # Config metadata added in 0012 — nullable/defaulted, no computed signal
    # involved (unlike the dialer telemetry this model's own doc comment
    # explicitly excludes).
    time_zone: Mapped[str | None] = mapped_column(String(64))
    week_start_day: Mapped[str | None] = mapped_column(String(9))
    day_boundary: Mapped[time | None] = mapped_column(Time)
    is_distributed_campaign: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    scheduling_period: Mapped[str | None] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class CampaignQueue(Base):
    """"Queues" under Campaigns in the reference console's own menu - which
    queues (org units) are assigned to a `Campaign`. A pure join row, no
    ledger semantics - removed outright when a queue is unassigned or its
    campaign is deleted."""

    __tablename__ = "campaign_queues"
    __table_args__ = ({"schema": "forecasting"},)

    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    campaign_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    org_unit_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
