"""§4.1's job-submission scaffolding, wired to §3.1's hard-constraint CP-SAT
model (Phase 2), §3.2/§3.3's soft constraints and fairness bound (Phase 3),
§5's infeasibility-handling relaxation search (Phase 4), §2.2 rule 1's
manual-override re-optimization (Phase 5), §4.3's gRPC data pulls
(Phase 6), and §7.1's decomposition (Phase 7).

Phase 7 (ADR-0060) splits every job-creating operation into an **enqueue**
half (`enqueue_submit_job`/`enqueue_relaxation_approval`/`enqueue_reoptimize`
- fast, API-side, persists a `queued` row and returns immediately, no gRPC
pull or CP-SAT call ever runs here) and an **execute** half (`execute_job`
- `app/worker.py`'s dispatch point, everything Phase 2-6 used to run inline
in the HTTP request: gRPC pulls, `app/solver/decomposition.py`'s per-site
split, `solve()` per group, merge, persist, publish). No code in this
module solves anything synchronously anymore.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

from nats.js import JetStreamContext
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.schemas import ReoptimizeScheduleRequest, ScheduleJobRequest
from app.core.errors import (
    DomainError,
    InvalidShiftDefinitionError,
    LockedAssignmentEmployeeMissingError,
    LockedShiftMissingFromReoptimizeRequestError,
    RelaxationNotAvailableError,
    ScheduleArchivedError,
    ScheduleByIdNotFoundError,
    ScheduleJobNotFoundError,
    ScheduleNotFoundError,
)
from app.core.worker_metrics import (
    JOBS_TOTAL,
    RELAXATION_CATEGORY_TOTAL,
    SOLVE_DURATION_SECONDS,
    scope_size_bucket,
)
from app.db.models import IdempotencyKey, Schedule, ScheduleJob, ShiftAssignment
from app.events import nats_publisher
from app.services import fairness_service, solve_input_conversion, solve_input_resolver, solve_input_serde
from app.solver.commercial_fallback import CommercialFallbackRequiredError, should_trigger_commercial_fallback
from app.solver.decomposition import DecompositionGroup, decompose
from app.solver.model import ShiftViolatesUnionRulesError, UnknownLockedAssignmentError, solve
from app.solver.relaxation import search_relaxations
from app.solver.types import RELAXATION_ORDER, LockedAssignment, SolveInput, SolveResult

logger = logging.getLogger("agno.scheduling.worker")

_SHIFT_ASSIGNMENT_INSERT = text(
    "INSERT INTO scheduling.shift_assignments "
    "(id, tenant_id, schedule_id, employee_id, shift_start, shift_end, "
    "skill_id, assignment_source, is_overtime, created_at, updated_at) "
    "VALUES (:id, :tenant_id, :schedule_id, :employee_id, :shift_start, :shift_end, "
    ":skill_id, :assignment_source, :is_overtime, :created_at, :updated_at)"
)


async def _find_existing_job_by_idempotency_key(
    session: AsyncSession, *, tenant_id: uuid.UUID, idempotency_key: str
) -> ScheduleJob | None:
    """Shared by every enqueue function - all three are job-creating
    operations under §4.1's `Idempotency-Key` requirement, so all three need
    the same "a previously-seen key returns the original job" replay
    check."""
    existing = await session.scalar(
        select(IdempotencyKey).where(
            IdempotencyKey.tenant_id == tenant_id,
            IdempotencyKey.idempotency_key == idempotency_key,
        )
    )
    if existing is None:
        return None
    job: ScheduleJob | None = await session.scalar(
        select(ScheduleJob).where(
            ScheduleJob.tenant_id == tenant_id,
            ScheduleJob.id == existing.schedule_job_id,
        )
    )
    return job


def _new_job(
    *,
    tenant_id: uuid.UUID,
    org_unit_id: uuid.UUID,
    forecast_run_id: uuid.UUID,
    date_range_start: date,
    date_range_end: date,
    job_kind: str,
    request_payload: dict[str, Any] | None,
    target_schedule_id: uuid.UUID | None,
    constraint_config: dict[str, Any],
    requested_by: uuid.UUID | None,
    now: datetime,
) -> ScheduleJob:
    return ScheduleJob(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        org_unit_id=org_unit_id,
        forecast_run_id=forecast_run_id,
        date_range_start=date_range_start,
        date_range_end=date_range_end,
        status="queued",
        job_kind=job_kind,
        request_payload=request_payload,
        target_schedule_id=target_schedule_id,
        constraint_config=constraint_config,
        requested_by=requested_by,
        solve_duration_ms=None,
        objective_score=None,
        decomposition_plan=None,
        relaxations_applied=None,
        solve_input_snapshot=None,
        claimed_by=None,
        solving_started_at=None,
        attempt_count=0,
        requested_at=now,
        completed_at=None,
        created_at=now,
        updated_at=now,
    )


# ---------------------------------------------------------------------------
# Enqueue (API-side, fast, no solving)
# ---------------------------------------------------------------------------


async def enqueue_submit_job(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    org_unit_id: uuid.UUID,
    forecast_run_id: uuid.UUID,
    date_range_start: date,
    date_range_end: date,
    constraint_config: dict[str, Any],
    idempotency_key: str,
    requested_by: uuid.UUID | None,
    request_payload: dict[str, Any] | None,
) -> tuple[ScheduleJob, bool]:
    """Returns `(job, created)` - `created` is False when an existing
    idempotency key was matched. `request_payload` is the full submitted
    `ScheduleJobRequest` body when `shiftSlots` is non-empty; `None` when
    it's empty - `app.worker`'s claim query never selects a `submit` row
    with a `NULL` payload, so it stays `queued` forever, exactly Phase 1's
    original "job scaffolding, no solver to run yet" behavior."""
    existing_job = await _find_existing_job_by_idempotency_key(
        session, tenant_id=tenant_id, idempotency_key=idempotency_key
    )
    if existing_job is not None:
        return existing_job, False

    now = datetime.now(UTC)
    job = _new_job(
        tenant_id=tenant_id,
        org_unit_id=org_unit_id,
        forecast_run_id=forecast_run_id,
        date_range_start=date_range_start,
        date_range_end=date_range_end,
        job_kind="submit",
        request_payload=request_payload,
        target_schedule_id=None,
        constraint_config=constraint_config,
        requested_by=requested_by,
        now=now,
    )
    session.add(job)
    await session.flush()  # job.id must be committed before any Schedule FK can reference it
    session.add(
        IdempotencyKey(
            tenant_id=tenant_id, idempotency_key=idempotency_key, schedule_job_id=job.id, created_at=now
        )
    )
    await session.flush()
    return job, True


async def enqueue_relaxation_approval(
    session: AsyncSession, *, tenant_id: uuid.UUID, job_id: uuid.UUID, approved_by: uuid.UUID | None
) -> ScheduleJob:
    """§5 point 4's human-approval gate. Flips an existing `infeasible` job
    back to `queued` with `job_kind=relaxation_approval` - `app.worker`
    re-solves from this same row's own `solve_input_snapshot`/
    `relaxations_applied.attemptedCategories` (Phase 4's existing fields,
    no new payload needed). `requested_by` doubles as "who approved this" -
    `execute_job` reads it back when recording `approvedBy`.

    Guards against re-approving an already-approved or already-pending
    job the same way it always did: `job.status != "infeasible"` is false
    for either case (an approval in flight already moved status to
    `queued`/`solving`; a completed approval already moved it to
    `completed`), so the existing check catches both without a separate
    "already pending" branch."""
    job = await get_job(session, tenant_id=tenant_id, job_id=job_id)
    if job.status != "infeasible" or job.relaxations_applied is None:
        raise RelaxationNotAvailableError(str(job_id), "job is not in a relaxation-pending state")
    if not job.relaxations_applied.get("feasible"):
        raise RelaxationNotAvailableError(str(job_id), "no feasible relaxation was found for this job")
    if job.relaxations_applied.get("approved"):
        raise RelaxationNotAvailableError(str(job_id), "this job's relaxation was already approved")
    if job.solve_input_snapshot is None:
        raise RelaxationNotAvailableError(str(job_id), "no solve input snapshot was recorded for this job")

    job.status = "queued"
    job.job_kind = "relaxation_approval"
    job.requested_by = approved_by
    job.claimed_by = None
    job.solving_started_at = None
    job.updated_at = datetime.now(UTC)
    await session.flush()
    return job


async def enqueue_reoptimize(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    schedule_id: uuid.UUID,
    request_payload: dict[str, Any],
    constraint_config: dict[str, Any],
    idempotency_key: str,
    requested_by: uuid.UUID | None,
) -> tuple[ScheduleJob, bool]:
    """§2.2 rule 1/ADR-0058's re-optimization entry point, Phase 7-async'd:
    validates the target schedule exists and isn't archived (fast, a single
    read - matching what a caller needs to know immediately), then enqueues.
    The heavier work - matching locked assignments into the resupplied
    `shiftSlots` (ADR-0058), which needs the full roster/shift data this
    function deliberately doesn't parse - is `app.worker`'s job
    (`_execute_reoptimize`). A locked-shift/employee mismatch that used to
    be a synchronous `422` is now an async `failed` job with the same
    structured reason - a real, acknowledged behavior change (ADR-0060
    Decision 5)."""
    existing_job = await _find_existing_job_by_idempotency_key(
        session, tenant_id=tenant_id, idempotency_key=idempotency_key
    )
    if existing_job is not None:
        return existing_job, False

    schedule = await session.scalar(
        select(Schedule).where(Schedule.tenant_id == tenant_id, Schedule.id == schedule_id)
    )
    if schedule is None:
        raise ScheduleByIdNotFoundError(str(schedule_id))
    if schedule.status == "archived":
        raise ScheduleArchivedError(str(schedule_id))

    source_job = await session.scalar(
        select(ScheduleJob).where(
            ScheduleJob.tenant_id == tenant_id, ScheduleJob.id == schedule.schedule_job_id
        )
    )
    if source_job is None:  # pathological direct-DB edit, not a real code path - the FK guarantees this
        raise ScheduleByIdNotFoundError(str(schedule_id))

    now = datetime.now(UTC)
    job = _new_job(
        tenant_id=tenant_id,
        org_unit_id=source_job.org_unit_id,
        forecast_run_id=source_job.forecast_run_id,
        date_range_start=source_job.date_range_start,
        date_range_end=source_job.date_range_end,
        job_kind="reoptimize",
        request_payload=request_payload,
        target_schedule_id=schedule_id,
        constraint_config=constraint_config,
        requested_by=requested_by,
        now=now,
    )
    session.add(job)
    await session.flush()
    session.add(
        IdempotencyKey(
            tenant_id=tenant_id, idempotency_key=idempotency_key, schedule_job_id=job.id, created_at=now
        )
    )
    await session.flush()
    return job, True


# ---------------------------------------------------------------------------
# Execute (worker-side: gRPC pulls, decomposition, solve, persist, publish)
# ---------------------------------------------------------------------------


async def execute_job(session: AsyncSession, *, js: JetStreamContext, job: ScheduleJob) -> None:
    """`app.worker`'s dispatch point, called once `job` has already been
    claimed (`status='solving'`, ADR-0060 Decision 2). Every `DomainError`
    a gRPC pull, decomposition, or `solve()` itself can raise - what used to
    surface as a synchronous 4xx/503/409 HTTP response (Phase 2-6) - is
    caught here and turned into a `failed` job with the same structured
    reason, since there is no HTTP response to attach it to anymore.
    Anything *not* a `DomainError`/`CommercialFallbackRequiredError`
    propagates to `app.worker`, which leaves the row in `solving` for the
    reaper (§7.2) rather than guessing at a clean failure state from
    whatever broke."""
    try:
        if job.job_kind == "submit":
            await _execute_submit(session, js=js, job=job)
        elif job.job_kind == "relaxation_approval":
            await _execute_relaxation_approval(session, js=js, job=job)
        elif job.job_kind == "reoptimize":
            await _execute_reoptimize(session, js=js, job=job)
        else:
            raise AssertionError(f"unknown job_kind {job.job_kind!r}")
    except DomainError as exc:
        await _fail_job(
            session, js=js, job=job, reason={"code": exc.code, "message": exc.message, "details": exc.details}
        )
    except CommercialFallbackRequiredError as exc:
        await _fail_job(
            session,
            js=js,
            job=job,
            reason={"code": "COMMERCIAL_FALLBACK_REQUIRED", "message": str(exc), "details": {}},
        )


async def _execute_submit(session: AsyncSession, *, js: JetStreamContext, job: ScheduleJob) -> None:
    assert job.request_payload is not None  # the worker's claim query excludes NULL payloads for `submit`
    body = ScheduleJobRequest.model_validate(job.request_payload)
    solve_input = await solve_input_resolver.resolve_submit_solve_input(
        body, session=session, tenant_id=job.tenant_id
    )
    if solve_input is None:
        return  # defensive - the claim query already excludes this case
    await _decompose_solve_persist(session, js=js, job=job, solve_input=solve_input)


async def _execute_relaxation_approval(
    session: AsyncSession, *, js: JetStreamContext, job: ScheduleJob
) -> None:
    assert job.relaxations_applied is not None
    assert job.solve_input_snapshot is not None
    original_input = solve_input_serde.deserialize(job.solve_input_snapshot)
    categories = frozenset(job.relaxations_applied["attemptedCategories"])
    # `dataclasses.replace`, not a field-by-field `SolveInput(...)` literal -
    # a manually-enumerated reconstruction silently drops any field added to
    # `SolveInput` after this code was written (this bit Phase 5's own
    # `locked_assignments` field before ADR-0058's own fix).
    relaxed_input = replace(original_input, relaxed_categories=categories)
    await _decompose_solve_persist(session, js=js, job=job, solve_input=relaxed_input, is_reproof=True)


async def _execute_reoptimize(session: AsyncSession, *, js: JetStreamContext, job: ScheduleJob) -> None:
    assert job.request_payload is not None
    assert job.target_schedule_id is not None
    payload = ReoptimizeScheduleRequest.model_validate(job.request_payload)
    schedule_id = job.target_schedule_id

    employees = tuple(solve_input_conversion.to_employee(e) for e in payload.roster)
    shifts = tuple(solve_input_conversion.to_shift_slot(s) for s in payload.shift_slots)
    policy = solve_input_conversion.to_policy(payload.policy)
    leave_records = tuple(solve_input_conversion.to_leave_record(lr) for lr in payload.leave_records)
    soft_weights = solve_input_conversion.to_soft_weights(payload.constraint_config.soft_weights)

    fairness_input = payload.constraint_config.fairness
    fairness = (
        solve_input_conversion.to_fairness_config(fairness_input) if fairness_input is not None else None
    )
    fairness_history_counts: dict[uuid.UUID, int] = {}
    if fairness is not None:
        assert fairness_input is not None
        window_start = job.date_range_start - timedelta(weeks=fairness_input.rolling_period_weeks)
        fairness_history_counts = await fairness_service.get_historical_undesirable_counts(
            session,
            tenant_id=job.tenant_id,
            employee_ids=[e.id for e in employees],
            window_start=window_start,
            window_end=job.date_range_start,
        )

    locked_rows = list(
        (
            await session.scalars(
                select(ShiftAssignment).where(
                    ShiftAssignment.tenant_id == job.tenant_id,
                    ShiftAssignment.schedule_id == schedule_id,
                    ShiftAssignment.assignment_source != "auto_generated",
                )
            )
        ).all()
    )
    shift_by_key = {(s.start, s.end, s.required_skill_id): s for s in shifts}
    locked_assignments: list[LockedAssignment] = []
    for row in locked_rows:
        matched = shift_by_key.get((row.shift_start, row.shift_end, row.skill_id))
        if matched is None:
            raise LockedShiftMissingFromReoptimizeRequestError(
                str(schedule_id),
                str(row.employee_id),
                row.shift_start.isoformat(),
                row.shift_end.isoformat(),
            )
        locked_assignments.append(
            LockedAssignment(
                employee_id=row.employee_id, shift_id=matched.id, assignment_source=row.assignment_source
            )
        )

    solve_input = SolveInput(
        date_range_start=job.date_range_start,
        date_range_end=job.date_range_end,
        employees=employees,
        shifts=shifts,
        policy=policy,
        leave_records=leave_records,
        fairness=fairness,
        soft_weights=soft_weights,
        fairness_history_counts=fairness_history_counts,
        locked_assignments=tuple(locked_assignments),
    )
    await _decompose_solve_persist(session, js=js, job=job, solve_input=solve_input)


async def _decompose_solve_persist(
    session: AsyncSession,
    *,
    js: JetStreamContext,
    job: ScheduleJob,
    solve_input: SolveInput,
    is_reproof: bool = False,
) -> None:
    """The shared core (ADR-0061): decompose, solve each group, and either
    persist a merged schedule (every group feasible), record a per-group
    relaxation search (any group infeasible - unless `is_reproof`, in which
    case that's a `RelaxationNotAvailableError`, not a fresh infeasibility
    to search around), or fail (any group `unknown`, or a
    `CommercialFallbackRequiredError` trigger)."""
    now = datetime.now(UTC)
    groups = decompose(solve_input)
    results: list[SolveResult] = []
    for group in groups:
        try:
            result = solve(group.solve_input)
        except ShiftViolatesUnionRulesError as exc:
            raise InvalidShiftDefinitionError(str(exc.shift_id), exc.reason) from exc
        except UnknownLockedAssignmentError as exc:
            raise LockedAssignmentEmployeeMissingError(str(exc.employee_id)) from exc
        if should_trigger_commercial_fallback(len(group.solve_input.employees), result):
            raise CommercialFallbackRequiredError(len(group.solve_input.employees))
        SOLVE_DURATION_SECONDS.labels(
            scope_size=scope_size_bucket(len(group.solve_input.employees))
        ).observe(result.solve_duration_ms / 1000.0)
        results.append(result)

    total_duration_ms = sum(r.solve_duration_ms for r in results)
    if any(r.status == "unknown" for r in results):
        job.status = "failed"
        job.completed_at = now
        job.solve_duration_ms = total_duration_ms
        await _publish(js, job)
        return

    infeasible = [(g, r) for g, r in zip(groups, results, strict=True) if r.status == "infeasible"]
    if infeasible:
        if is_reproof:
            raise RelaxationNotAvailableError(
                str(job.id),
                "re-solving with the approved relaxation did not reproduce a feasible schedule",
            )
        job.status = "infeasible"
        job.completed_at = now
        job.solve_duration_ms = total_duration_ms
        job.relaxations_applied = _build_relaxations_applied(infeasible)
        job.solve_input_snapshot = solve_input_serde.serialize(solve_input)
        await _publish(js, job)
        return

    merged_result = SolveResult(
        status="optimal" if all(r.status == "optimal" for r in results) else "feasible",
        assignments=tuple(a for r in results for a in r.assignments),
        solve_duration_ms=total_duration_ms,
        objective_value=_sum_or_none(r.objective_value for r in results),
    )
    job.status = "completed"
    job.completed_at = now
    job.solve_duration_ms = total_duration_ms
    job.objective_score = _to_decimal(merged_result.objective_value)
    job.decomposition_plan = _build_decomposition_plan(groups, results)
    # `solve_input.shifts`/`.locked_assignments` already hold every group's
    # own subset (decomposition partitions, never drops) - no need to
    # rebuild a "merged" SolveInput, the original already has everything
    # `_persist_schedule` looks up.
    await _persist_schedule(
        session,
        tenant_id=job.tenant_id,
        org_unit_id=job.org_unit_id,
        job=job,
        solve_input=solve_input,
        result=merged_result,
        now=now,
    )
    if is_reproof:
        assert job.relaxations_applied is not None
        job.relaxations_applied = {
            **job.relaxations_applied,
            "approved": True,
            "approvedAt": now.isoformat(),
            "approvedBy": str(job.requested_by) if job.requested_by else None,
        }
    await _publish(js, job)


def _sum_or_none(values: Any) -> float | None:
    collected = [v for v in values if v is not None]
    return sum(collected) if collected else None


def _build_decomposition_plan(
    groups: list[DecompositionGroup], results: list[SolveResult]
) -> dict[str, Any]:
    return {
        "decomposed": len(groups) > 1,
        "groupCount": len(groups),
        "groups": [
            {
                "groupId": g.group_id,
                "orgUnitIds": sorted(str(x) for x in g.org_unit_ids),
                "employeeCount": len(g.solve_input.employees),
                "shiftCount": len(g.solve_input.shifts),
                "status": r.status,
                "solveDurationMs": r.solve_duration_ms,
            }
            for g, r in zip(groups, results, strict=True)
        ],
    }


def _build_relaxations_applied(
    infeasible: list[tuple[DecompositionGroup, SolveResult]],
) -> dict[str, Any]:
    """§5's structured payload, extended for decomposition (ADR-0061): a
    single (non-decomposed) job's shape is unchanged from Phase 4; a
    decomposed job's `costSummary`/`explanation` become per-group, keyed by
    `groupId`, since a category needed by one site and not another is a
    real, useful distinction to preserve rather than flatten away."""
    per_group: dict[str, Any] = {}
    all_categories: list[str] = []
    all_feasible = True
    for group, _result in infeasible:
        search_result = search_relaxations(group.solve_input)
        per_group[group.group_id] = {
            "attemptedCategories": list(search_result.attempted_categories),
            "feasible": search_result.feasible,
            "costSummary": dict(search_result.cost_summary),
            "explanation": search_result.explanation,
        }
        for category in search_result.attempted_categories:
            if category not in all_categories:
                all_categories.append(category)
        all_feasible = all_feasible and search_result.feasible

    ordered_categories = [c for c in RELAXATION_ORDER if c in all_categories]
    for category in ordered_categories:
        RELAXATION_CATEGORY_TOTAL.labels(category=category).inc()
    if len(per_group) == 1:
        single = next(iter(per_group.values()))
        cost_summary = single["costSummary"]
        explanation = single["explanation"]
    else:
        cost_summary = {"perGroup": per_group}
        explanation = "; ".join(f"{group_id}: {v['explanation']}" for group_id, v in per_group.items())

    return {
        "attemptedCategories": ordered_categories,
        "feasible": all_feasible,
        "costSummary": cost_summary,
        "explanation": explanation,
        "approved": False,
        "approvedAt": None,
        "approvedBy": None,
    }


async def _fail_job(
    session: AsyncSession, *, js: JetStreamContext, job: ScheduleJob, reason: dict[str, Any]
) -> None:
    job.status = "failed"
    job.completed_at = datetime.now(UTC)
    job.relaxations_applied = {**(job.relaxations_applied or {}), "failureReason": reason}
    await _publish(js, job)


async def _publish(js: JetStreamContext, job: ScheduleJob) -> None:
    # §6/Phase 6: the completion event Module 10's explanation-generation
    # trigger subscribes to (ADR-0059) - published for every terminal solve
    # outcome, not just `completed`.
    await nats_publisher.publish_job_completed(
        js,
        tenant_id=job.tenant_id,
        schedule_job_id=job.id,
        org_unit_id=job.org_unit_id,
        status=job.status,  # type: ignore[arg-type]
    )
    JOBS_TOTAL.labels(status=job.status).inc()
    # §8: "infeasible-rate by org unit" - deliberately a structured log
    # field, not a Prometheus label (`org_unit_id` is unbounded cardinality
    # - see `app/core/worker_metrics.py`'s own module docstring for why). A
    # real deployment slices this from a log-aggregation backend.
    logger.info(
        "job reached terminal status",
        extra={
            "fields": {
                "jobId": str(job.id),
                "tenantId": str(job.tenant_id),
                "orgUnitId": str(job.org_unit_id),
                "jobKind": job.job_kind,
                "status": job.status,
                "solveDurationMs": job.solve_duration_ms,
            }
        },
    )


async def _persist_schedule(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    org_unit_id: uuid.UUID,
    job: ScheduleJob,
    solve_input: SolveInput,
    result: SolveResult,
    now: datetime,
) -> None:
    """Shared by every successful solve path (`submit`, `relaxation_approval`
    reproof, `reoptimize`) regardless of whether it was decomposed.

    Phase 5/ADR-0058: a locked pair's real `assignment_source`
    (`manual_override`/`swap`/`bid`) is read straight off
    `solve_input.locked_assignments` - it rides along on the `SolveInput`
    itself (through `dataclasses.replace` in the relaxation-approval path
    and through `solve_input_serde` round-trips) rather than as a
    side-channel parameter here. Every pair with no locked entry (the
    ordinary first-time-solve case) still defaults to `auto_generated`,
    exactly as before this field existed."""
    locked_sources = {
        (la.employee_id, la.shift_id): la.assignment_source for la in solve_input.locked_assignments
    }
    shift_by_id = {s.id: s for s in solve_input.shifts}
    schedule = Schedule(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        schedule_job_id=job.id,
        org_unit_id=org_unit_id,
        status="draft",
        published_at=None,
        published_by=None,
        created_at=now,
        updated_at=now,
    )
    session.add(schedule)
    # schedule.id must be committed before any ShiftAssignment FK can reference it.
    await session.flush()
    # Raw parameterized `text()` INSERT, not `session.add(ShiftAssignment(...))`
    # - one row per `execute()` call. `locked` is deliberately absent from
    # the column list (it's `GENERATED ALWAYS`, ADR-0054; Postgres computes
    # it from `assignment_source` on every write). Two or more
    # `ShiftAssignment` rows added via the ORM in one flush hits a genuine
    # SQLAlchemy/asyncpg "insertmanyvalues" sentinel-matching failure for
    # this table's composite `(id, shift_start)` primary key
    # (`InvalidRequestError: Can't match sentinel values...`) - see
    # ADR-0056.
    for assignment in result.assignments:
        shift = shift_by_id[assignment.shift_id]
        pair_key = (assignment.employee_id, assignment.shift_id)
        assignment_source = locked_sources.get(pair_key, "auto_generated")
        await session.execute(
            _SHIFT_ASSIGNMENT_INSERT,
            {
                "id": uuid.uuid4(),
                "tenant_id": tenant_id,
                "schedule_id": schedule.id,
                "employee_id": assignment.employee_id,
                "shift_start": shift.start,
                "shift_end": shift.end,
                "skill_id": shift.required_skill_id,
                "assignment_source": assignment_source,
                "is_overtime": assignment.is_overtime,
                "created_at": now,
                "updated_at": now,
            },
        )


def _to_decimal(value: float | None) -> Decimal | None:
    # `Decimal(str(...))`, not `Decimal(...)` directly - avoids importing
    # the float's own binary-representation noise into the column (e.g.
    # `Decimal(0.1)` != `Decimal("0.1")`).
    return Decimal(str(value)) if value is not None else None


async def get_job(session: AsyncSession, *, tenant_id: uuid.UUID, job_id: uuid.UUID) -> ScheduleJob:
    job = await session.scalar(
        select(ScheduleJob).where(ScheduleJob.tenant_id == tenant_id, ScheduleJob.id == job_id)
    )
    if job is None:
        raise ScheduleJobNotFoundError(str(job_id))
    return job


async def list_jobs(
    session: AsyncSession, *, tenant_id: uuid.UUID, org_unit_id: uuid.UUID, limit: int = 20
) -> list[ScheduleJob]:
    """Real history for the Mass Schedule Editor — there was previously no
    way to see past solves for an org unit, only look one up by a job id
    you already had (a real, now-closed gap)."""
    stmt = (
        select(ScheduleJob)
        .where(ScheduleJob.tenant_id == tenant_id, ScheduleJob.org_unit_id == org_unit_id)
        .order_by(ScheduleJob.requested_at.desc())
        .limit(limit)
    )
    return list((await session.scalars(stmt)).all())


async def get_schedule_with_assignments(
    session: AsyncSession, *, tenant_id: uuid.UUID, job_id: uuid.UUID
) -> tuple[Schedule, list[ShiftAssignment]]:
    schedule = await session.scalar(
        select(Schedule).where(Schedule.tenant_id == tenant_id, Schedule.schedule_job_id == job_id)
    )
    if schedule is None:
        raise ScheduleNotFoundError(str(job_id))
    assignments = list(
        (
            await session.scalars(
                select(ShiftAssignment).where(
                    ShiftAssignment.tenant_id == tenant_id, ShiftAssignment.schedule_id == schedule.id
                )
            )
        ).all()
    )
    return schedule, assignments
