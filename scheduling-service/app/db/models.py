"""SQLAlchemy 2.0 declarative models - the Python-side source of truth for
column names/types, mirroring the role `*.entity.ts` files play in Module
01/02 and `app/db/models.py` plays in Module 03 (ADR-0016). The authoritative
DDL (RLS, partitioning, grants, the `locked` generated column) lives in
`migrations/versions/0001_initial_schema.py`; these models are kept in sync
with it by hand, the same accepted trade-off ADR-0001/0016 made.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import Boolean, Computed, Date, DateTime, Integer, Numeric, String, Time
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class ScheduleJob(Base):
    __tablename__ = "schedule_jobs"
    __table_args__ = ({"schema": "scheduling"},)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    org_unit_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    # No FK into forecasting.forecast_runs - cross-module reads are a gRPC
    # contract, not a shared schema. See docs/adr/0052.
    forecast_run_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    date_range_start: Mapped[date] = mapped_column(Date, nullable=False)
    date_range_end: Mapped[date] = mapped_column(Date, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="queued")
    constraint_config: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    requested_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    solve_duration_ms: Mapped[int | None] = mapped_column(Integer)
    objective_score: Mapped[Decimal | None] = mapped_column(Numeric(14, 4))
    decomposition_plan: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    relaxations_applied: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    # §5's relaxation-approval flow (Phase 4, migration 0003) - populated
    # only when this job resolves to `infeasible`, so `approve_relaxation`
    # can re-solve without the caller resending the original payload.
    solve_input_snapshot: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    # Phase 7/8 (ADR-0060, migration 0004) - the async worker pool's own
    # fields. `job_kind` dispatches `app.worker`'s execution logic;
    # `request_payload` is `submit`/`reoptimize`'s resupplied input (a
    # `relaxation_approval` row needs none - it reuses this same row's own
    # `solve_input_snapshot`/`relaxations_applied` instead).
    job_kind: Mapped[str] = mapped_column(String(24), nullable=False, default="submit")
    request_payload: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    target_schedule_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    claimed_by: Mapped[str | None] = mapped_column(String(255))
    solving_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class Schedule(Base):
    __tablename__ = "schedules"
    __table_args__ = ({"schema": "scheduling"},)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    schedule_job_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    org_unit_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="draft")
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    published_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ShiftAssignment(Base):
    """`locked` is `GENERATED ALWAYS AS (assignment_source <> 'auto_generated')
    STORED` in the migration (ADR-0054) - the DB derives it from
    `assignment_source` on every write, so no application code path can set
    it directly. Mapped via SQLAlchemy's `Computed(...)` construct so the ORM
    knows to omit `locked` from INSERT/UPDATE entirely (any explicit value,
    even a matching one, is a hard Postgres error against a `GENERATED
    ALWAYS` column - `asyncpg.exceptions.GeneratedAlwaysError`) - found by
    actually inserting a row via this model against the real migrated
    schema, not assumed correct from the migration SQL alone."""

    __tablename__ = "shift_assignments"
    __table_args__ = ({"schema": "scheduling"},)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    schedule_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    # No FK into org.employees/org.employee_skills - gRPC-contract boundary,
    # same reasoning as ScheduleJob.forecast_run_id.
    employee_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    shift_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    shift_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    skill_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    assignment_source: Mapped[str] = mapped_column(String(16), nullable=False, default="auto_generated")
    is_overtime: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    locked: Mapped[bool] = mapped_column(
        Boolean, Computed("assignment_source <> 'auto_generated'", persisted=True), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ScheduleExplanation(Base):
    """Schema only in this phase - `summary_text`/`top_constraints_json`/
    `trade_offs_json` are populated by the Phase 6 handoff to Module 10
    (§4/module non-goals: this module requests the explanation, it does not
    generate it)."""

    __tablename__ = "schedule_explanations"
    __table_args__ = ({"schema": "scheduling"},)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    schedule_job_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    summary_text: Mapped[str | None] = mapped_column(String)
    top_constraints_json: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    trade_offs_json: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    generated_by_model_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ScheduleConflict(Base):
    __tablename__ = "schedule_conflicts"
    __table_args__ = ({"schema": "scheduling"},)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    schedule_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    conflict_type: Mapped[str] = mapped_column(String(24), nullable=False)
    # No FK into org.employees - gRPC-contract boundary, same as elsewhere.
    affected_employee_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="open")
    suggested_resolution_json: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class IdempotencyKey(Base):
    """§4.1's `Idempotency-Key` requirement on `POST /v1/scheduling/jobs`,
    same mechanism as Module 03's own `idempotency_keys` table."""

    __tablename__ = "idempotency_keys"
    __table_args__ = ({"schema": "scheduling"},)

    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    idempotency_key: Mapped[str] = mapped_column(String(255), primary_key=True)
    schedule_job_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class FairnessLedger(Base):
    """§3.3's cross-run read model (Phase 3) - written once per
    `ShiftAssignment` at *publish* time (`schedule_service.publish_schedule`),
    never at solve time. `is_undesirable` is frozen at that moment using the
    publishing job's own `constraint_config` (or the platform default if it
    set none) - an auditor re-deriving "was this fair" later reads the
    stored flag, not live shift-time arithmetic, so the answer never drifts
    if the platform's definition of "undesirable" changes after the fact."""

    __tablename__ = "fairness_ledger"
    __table_args__ = ({"schema": "scheduling"},)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    employee_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    schedule_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    shift_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    shift_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    is_undesirable: Mapped[bool] = mapped_column(Boolean, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ShiftTemplate(Base):
    """A reusable, named shift definition (e.g. "Morning", 09:00-17:00) — a
    time-of-day pair with no attached date, picked when composing a
    schedule's shift coverage instead of typing start/end datetimes by hand
    every time. Purely a UI convenience at solve time: `ScheduleJobRequest`/
    `ReoptimizeScheduleRequest` still take real, concrete `ShiftSlotInput`
    datetimes — a template is expanded onto a chosen date client-side, never
    referenced by id anywhere in the solver itself."""

    __tablename__ = "shift_templates"
    __table_args__ = ({"schema": "scheduling"},)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    start_time: Mapped[Any] = mapped_column(Time, nullable=False)
    end_time: Mapped[Any] = mapped_column(Time, nullable=False)
    break_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    required_skill_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    default_headcount: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class WorkPattern(Base):
    """A named, repeating rotation cycle ("Work Patterns" in the reference
    console's own menu) — e.g. a 7-day "4-on-3-off" cycle referencing which
    `ShiftTemplate` (or none, for an off day) applies on each day of the
    cycle. `days` is a JSONB array of `shift_template_id | null`, one entry
    per day — length is the cycle length, no separate column for it. Purely
    reference data assignable to an employee/org unit elsewhere; nothing in
    the solver reads this table (same "not referenced by the solver itself"
    posture as `ShiftTemplate` — see its own doc comment)."""

    __tablename__ = "work_patterns"
    __table_args__ = ({"schema": "scheduling"},)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    days: Mapped[list[Any]] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class StaffingProfile(Base):
    """A named, reusable bundle of coverage requirements ("Staffing Profiles"
    under "Scenarios" in the reference console's own menu) — a list of
    `{shift_template_id, required_headcount}` entries, e.g. "Standard
    weekday": Morning x3, Afternoon x2, Evening x1. Meant to be picked when
    composing a schedule's shift coverage instead of re-entering the same
    headcount requirements from scratch every time (same "not referenced by
    the solver itself" posture as `ShiftTemplate`/`WorkPattern` — expanded
    into real `ShiftSlotInput`s client-side before a solve, never
    referenced by id in the solver). `entries` is JSONB, same storage shape
    as `WorkPattern.days`."""

    __tablename__ = "staffing_profiles"
    __table_args__ = ({"schema": "scheduling"},)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    entries: Mapped[list[Any]] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ShiftEventRequest(Base):
    """The unified mechanism behind "Shift Events", "VTO Events", and "OT
    Extensions" in the reference console's own menu — one request/approval
    workflow with an `event_type` discriminator, same "one shared table,
    typed by an enum column" shape `SpecialEvent` already uses in
    forecasting-service, rather than three near-identical tables:
      - shift_change: a change to an already-scheduled shift
      - vto: voluntary time off released from an already-scheduled shift
      - overtime_extension: a request to extend/add overtime on a shift
    `requested_hours` is the VTO hours released or overtime hours
    requested, depending on `event_type`; null for a plain `shift_change`.
    Same pending/approved/rejected shape as Module 06's own `LeaveRequest`
    decision flow — a rejection requires a reason, enforced at the API
    layer (`decision_reason` required when `status='rejected'`)."""

    __tablename__ = "shift_event_requests"
    __table_args__ = ({"schema": "scheduling"},)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    employee_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    event_type: Mapped[str] = mapped_column(String(20), nullable=False)
    shift_date: Mapped[date] = mapped_column(Date, nullable=False)
    requested_hours: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    reason: Mapped[str] = mapped_column(String(500), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    decision_reason: Mapped[str | None] = mapped_column(String(500))
    requested_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    decided_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ProjectRule(Base):
    """A reusable, named `EmploymentPolicyInput` bundle ("Project Rules" in
    the reference console's own menu) - the same constraint shape a schedule
    job already takes inline (`ScheduleJobRequest.policy`), saved under a
    name so a recurring client engagement's constraints ("no OT allowed on
    the Acme project", "12h minimum rest") can be picked instead of
    re-entered by hand every time. Purely a UI convenience at solve time,
    same trade-off `ShiftTemplate`'s own doc comment makes - never
    referenced by id from the solver itself, only expanded into a real
    `EmploymentPolicyInput` client-side."""

    __tablename__ = "project_rules"
    __table_args__ = ({"schema": "scheduling"},)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str | None] = mapped_column(String(500))
    max_consecutive_working_days: Mapped[int] = mapped_column(Integer, nullable=False)
    min_rest_hours_between_shifts: Mapped[Decimal] = mapped_column(Numeric(4, 1), nullable=False)
    min_shift_length_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    max_shift_length_minutes: Mapped[int | None] = mapped_column(Integer)
    allows_overtime: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
