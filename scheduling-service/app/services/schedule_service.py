"""§3.3's ledger-refresh trigger lives here: publishing a `Schedule` is the
"off `Schedule.published_at` events" moment the module prompt names for
`FairnessLedger` writes - the ledger is populated once, at publish time,
never at solve time (a solve that's never published never contributes to
anyone's fairness history). Also this service's home for the fairness
compliance-auditor query (§3.3: "show me the fairness tolerance policy in
effect for period X and prove no employee exceeded it").
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime

from nats.js import JetStreamContext
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import (
    ScheduleArchivedError,
    ScheduleByIdNotFoundError,
    ScheduleConflictNotFoundError,
    ScheduleNotPublishableError,
    ShiftAssignmentNotFoundByIdError,
    ShiftAssignmentNotFoundError,
)
from app.db.models import FairnessLedger, Schedule, ScheduleConflict, ScheduleJob, ShiftAssignment
from app.events import nats_publisher
from app.services import fairness_service


async def publish_schedule(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    schedule_id: uuid.UUID,
    published_by: uuid.UUID | None,
    js: JetStreamContext,
) -> tuple[Schedule, list[ShiftAssignment]]:
    schedule = await session.scalar(
        select(Schedule).where(Schedule.tenant_id == tenant_id, Schedule.id == schedule_id)
    )
    if schedule is None:
        raise ScheduleByIdNotFoundError(str(schedule_id))
    if schedule.status != "draft":
        raise ScheduleNotPublishableError(str(schedule_id), schedule.status)

    job = await session.scalar(
        select(ScheduleJob).where(
            ScheduleJob.tenant_id == tenant_id, ScheduleJob.id == schedule.schedule_job_id
        )
    )
    # `job` is always present in practice (the FK that created `schedule`
    # guarantees it) - the empty-dict fallback only protects against a
    # pathological direct-DB edit, not a real code path.
    fairness_config = fairness_service.parse_fairness_config(job.constraint_config if job else {})

    assignments = list(
        (
            await session.scalars(
                select(ShiftAssignment).where(
                    ShiftAssignment.tenant_id == tenant_id, ShiftAssignment.schedule_id == schedule.id
                )
            )
        ).all()
    )
    now = datetime.now(UTC)
    # Raw parameterized `text()` INSERT, not `session.add(FairnessLedger(...))`
    # or Core `insert(FairnessLedger)` - every column here (including both
    # halves of the composite `(id, shift_start)` primary key) is already
    # known client-side, so nothing needs to come back from a RETURNING
    # round-trip. Both ORM `add()` and Core `insert()` route through
    # SQLAlchemy's statement compiler, which - for this table specifically,
    # only when executed via the real FastAPI/TestClient request path, not
    # a bare asyncio script - hits a genuine SQLAlchemy/asyncpg
    # "insertmanyvalues" sentinel-matching failure (`InvalidRequestError:
    # Can't match sentinel values...`) even for a single row with no list
    # params involved. Root cause not fully pinned down (bisected out
    # batching, out-of-session datetime round-tripping, and statement-cache
    # pollution from other tests - none reproduced it in isolation); `text()`
    # bypasses that compiler path entirely and is unaffected regardless of
    # the underlying cause, so it's used here as the robust fix rather than
    # a workaround chasing an unconfirmed theory.
    insert_stmt = text(
        "INSERT INTO scheduling.fairness_ledger "
        "(id, tenant_id, employee_id, schedule_id, shift_start, shift_end, is_undesirable, created_at) "
        "VALUES (:id, :tenant_id, :employee_id, :schedule_id, :shift_start, :shift_end, "
        ":is_undesirable, :created_at)"
    )
    for assignment in assignments:
        await session.execute(
            insert_stmt,
            {
                "id": uuid.uuid4(),
                "tenant_id": tenant_id,
                "employee_id": assignment.employee_id,
                "schedule_id": schedule.id,
                "shift_start": assignment.shift_start,
                "shift_end": assignment.shift_end,
                "is_undesirable": fairness_config.is_undesirable(assignment.shift_start),
                "created_at": now,
            },
        )

    schedule.status = "published"
    schedule.published_at = now
    schedule.published_by = published_by
    await session.flush()
    # Module 05 Phase 2 (§2.2 rule 2, docs/adr/0064): published *before* this
    # transaction commits, deliberately matching `job_service._publish`'s
    # own existing precedent (job_service.py:463,478,513,593) rather than
    # inventing a new commit-then-publish ordering for this one call site.
    await nats_publisher.publish_schedule_published(
        js,
        tenant_id=tenant_id,
        schedule_id=schedule.id,
        org_unit_id=schedule.org_unit_id,
        published_at=now,
        employee_ids=[a.employee_id for a in assignments],
    )
    return schedule, assignments


async def list_employee_shift_assignments(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    employee_id: uuid.UUID,
    window_start: datetime,
    window_end: datetime,
) -> list[tuple[ShiftAssignment, Schedule]]:
    """Module 05 Phase 2 (§2.2 rule 2, docs/adr/0064): the read side of the
    `scheduled_activity` pre-load - only assignments on a `status:
    published` schedule are ever returned (a draft isn't real yet), and only
    those overlapping `[window_start, window_end)`. Returned paired with
    `Schedule` (not just `ShiftAssignment`) so the caller gets
    `published_at` without a second round-trip - `schedule_id` is an
    intra-schema column (unlike `employee_id`), so this join is a normal
    same-database join, not a cross-module reach."""
    result = await session.execute(
        select(ShiftAssignment, Schedule)
        .join(Schedule, Schedule.id == ShiftAssignment.schedule_id)
        .where(
            ShiftAssignment.tenant_id == tenant_id,
            ShiftAssignment.employee_id == employee_id,
            Schedule.tenant_id == tenant_id,
            Schedule.status == "published",
            ShiftAssignment.shift_start < window_end,
            ShiftAssignment.shift_end > window_start,
        )
        .order_by(ShiftAssignment.shift_start)
    )
    return [(row[0], row[1]) for row in result.all()]


async def list_shift_assignments_for_employees(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    employee_ids: list[uuid.UUID],
    window_start: datetime,
    window_end: datetime,
) -> list[tuple[ShiftAssignment, Schedule]]:
    """Module 08 Phase 5 (docs/adr/0103): the bulk counterpart to
    `list_employee_shift_assignments` - `RuleChangeImpactPreview`'s
    simulation needs every affected employee's published assignments in one
    query, not one REST round-trip per employee. Same "published only,
    window-overlap" filter, ordered by employee then shift start so the
    gRPC servicer can group consecutive rows per employee without an
    intermediate dict. Empty `employee_ids` returns `[]` without querying -
    the caller (an org unit with a currently-empty roster) is a real,
    unexceptional case, not an error."""
    if not employee_ids:
        return []
    result = await session.execute(
        select(ShiftAssignment, Schedule)
        .join(Schedule, Schedule.id == ShiftAssignment.schedule_id)
        .where(
            ShiftAssignment.tenant_id == tenant_id,
            ShiftAssignment.employee_id.in_(employee_ids),
            Schedule.tenant_id == tenant_id,
            Schedule.status == "published",
            ShiftAssignment.shift_start < window_end,
            ShiftAssignment.shift_end > window_start,
        )
        .order_by(ShiftAssignment.employee_id, ShiftAssignment.shift_start)
    )
    return [(row[0], row[1]) for row in result.all()]


async def override_assignment(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    schedule_id: uuid.UUID,
    assignment_id: uuid.UUID,
    new_employee_id: uuid.UUID,
    js: JetStreamContext,
) -> ShiftAssignment:
    """§4.2's `overrideAssignment` mutation, this service's REST equivalent:
    reassigns `assignment_id` to `new_employee_id` and sets
    `assignment_source: manual_override` (§2.2 rule 1) - `locked` follows
    automatically, it's `GENERATED ALWAYS` from `assignment_source`
    (ADR-0054). Deliberately bypasses every §3.1 eligibility check (skill
    match, leave, contracted hours) the solver would normally enforce - a
    human override is trusted, not re-validated (ADR-0058 point 4's same
    reasoning, applied at the point the override is actually made rather
    than at the next re-optimization).

    The one thing this *does* check is `double_booking` (ADR-0058's "what's
    actually derivable today" scoping): if the override gives
    `new_employee_id` two assignments on this schedule with overlapping
    `[shift_start, shift_end)` windows, a `ScheduleConflict` row is written
    so it surfaces to whoever reviews open conflicts - the override still
    succeeds (a human is allowed to create a real scheduling conflict
    on purpose, e.g. as a temporary stopgap), it's just not silently
    invisible afterward."""
    schedule = await session.scalar(
        select(Schedule).where(Schedule.tenant_id == tenant_id, Schedule.id == schedule_id)
    )
    if schedule is None:
        raise ScheduleByIdNotFoundError(str(schedule_id))
    if schedule.status == "archived":
        raise ScheduleArchivedError(str(schedule_id))

    assignment = await session.scalar(
        select(ShiftAssignment).where(
            ShiftAssignment.tenant_id == tenant_id,
            ShiftAssignment.schedule_id == schedule_id,
            ShiftAssignment.id == assignment_id,
        )
    )
    if assignment is None:
        raise ShiftAssignmentNotFoundError(str(schedule_id), str(assignment_id))

    now = datetime.now(UTC)
    assignment.employee_id = new_employee_id
    assignment.assignment_source = "manual_override"
    assignment.updated_at = now

    await _record_double_booking_if_any(
        session, tenant_id=tenant_id, schedule_id=schedule_id, assignment=assignment, now=now
    )

    await session.flush()
    # `locked` is `GENERATED ALWAYS` (ADR-0054) - `flush()` expires it on
    # this instance since the DB, not this process, just recomputed it from
    # the new `assignment_source`. A bare post-flush attribute access would
    # try to lazy-load it outside an awaited context
    # (`sqlalchemy.exc.MissingGreenlet`) - `refresh()` does that reload
    # properly, awaited, before the caller (the API layer) ever touches
    # `.locked`.
    await session.refresh(assignment)
    # Module 05 Phase 2 (§2.2 rule 2, docs/adr/0064): lets a mid-shift
    # override be reflected in `AgentLiveState.scheduled_activity`
    # immediately rather than waiting for the next `ShiftStartPreloadSchedulerService`
    # tick - same pre-commit publish ordering as `publish_schedule` above.
    await nats_publisher.publish_assignment_changed(
        js,
        tenant_id=tenant_id,
        schedule_id=schedule_id,
        assignment_id=assignment.id,
        employee_id=assignment.employee_id,
        shift_start=assignment.shift_start,
        shift_end=assignment.shift_end,
        changed_at=now,
        reason="manual_override",
    )
    return assignment


async def _record_double_booking_if_any(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    schedule_id: uuid.UUID,
    assignment: ShiftAssignment,
    now: datetime,
) -> None:
    """Shared by `override_assignment` and the two Module 07 (ADR-0089)
    marketplace-reassignment functions below - the same "still succeeds,
    just not silently invisible afterward" `double_booking` check
    `override_assignment`'s own docstring describes, factored out once it
    had a third real call site rather than copied a third time."""
    other_assignments = list(
        (
            await session.scalars(
                select(ShiftAssignment).where(
                    ShiftAssignment.tenant_id == tenant_id,
                    ShiftAssignment.schedule_id == schedule_id,
                    ShiftAssignment.employee_id == assignment.employee_id,
                    ShiftAssignment.id != assignment.id,
                )
            )
        ).all()
    )
    has_double_booking = any(
        assignment.shift_start < other.shift_end and other.shift_start < assignment.shift_end
        for other in other_assignments
    )
    if has_double_booking:
        session.add(
            ScheduleConflict(
                id=uuid.uuid4(),
                tenant_id=tenant_id,
                schedule_id=schedule_id,
                conflict_type="double_booking",
                affected_employee_id=assignment.employee_id,
                status="open",
                suggested_resolution_json=None,
                created_at=now,
                updated_at=now,
            )
        )


async def _load_assignment_by_id(
    session: AsyncSession, *, tenant_id: uuid.UUID, assignment_id: uuid.UUID
) -> ShiftAssignment:
    assignment = await session.scalar(
        select(ShiftAssignment).where(
            ShiftAssignment.tenant_id == tenant_id, ShiftAssignment.id == assignment_id
        )
    )
    if assignment is None:
        raise ShiftAssignmentNotFoundByIdError(str(assignment_id))
    return assignment


async def apply_marketplace_claim(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    shift_assignment_id: uuid.UUID,
    new_employee_id: uuid.UUID,
    js: JetStreamContext,
    source: str = "open_shift_claim",
) -> ShiftAssignment:
    """Module 07 Phase 5 (ADR-0089): applies an approved `ShiftClaimApproved`
    marketplace event - the NATS-consumer counterpart to `override_assignment`.
    Looked up by `(tenant_id, id)` alone, not `(tenant_id, schedule_id, id)` -
    the marketplace event carries no `schedule_id` (Module 07 never stores
    one, §2.1's own `MarketplacePost`/`MarketplaceClaim` DDL has no such
    column), unlike the REST override endpoint's own request shape.

    Same eligibility-bypass posture as `override_assignment` for the same
    reason: Module 07 already ran the real guardrail check
    (`SchedulingEligibilityService.CheckAssignmentEligibility`, ADR-0082)
    before ever approving the claim - re-validating here would be exactly
    the "parallel implementation" this platform's own non-negotiable (§0 in
    Module 07's own prompt) forbids, not an extra safety net.

    `source` (ADR-0159): 'bid' when the event came from a closed
    `BidOpportunity`'s winner, 'open_shift_claim' otherwise - `bid` has been
    a valid `assignment_source` value since 0001's very first migration but
    was never reachable until Module 07 actually started converting bid
    winners into claims.
    """
    assignment_source = "bid" if source == "bid" else "claim"
    assignment = await _load_assignment_by_id(session, tenant_id=tenant_id, assignment_id=shift_assignment_id)
    now = datetime.now(UTC)
    assignment.employee_id = new_employee_id
    assignment.assignment_source = assignment_source
    assignment.updated_at = now

    await _record_double_booking_if_any(
        session, tenant_id=tenant_id, schedule_id=assignment.schedule_id, assignment=assignment, now=now
    )

    await session.flush()
    await session.refresh(assignment)
    await nats_publisher.publish_assignment_changed(
        js,
        tenant_id=tenant_id,
        schedule_id=assignment.schedule_id,
        assignment_id=assignment.id,
        employee_id=assignment.employee_id,
        shift_start=assignment.shift_start,
        shift_end=assignment.shift_end,
        changed_at=now,
        reason=assignment_source,
    )
    return assignment


async def apply_marketplace_swap(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    initiator_shift_id: uuid.UUID,
    initiator_employee_id: uuid.UUID,
    target_shift_id: uuid.UUID,
    target_employee_id: uuid.UUID,
    js: JetStreamContext,
) -> tuple[ShiftAssignment, ShiftAssignment]:
    """Module 07 Phase 5 (ADR-0089): applies an approved `SwapExecuted`
    marketplace event - both sides of the trade in one transaction (both
    reassignments succeed together or neither does; a half-completed swap
    would be a real data-integrity bug, worse than not swapping at all).
    `initiator_shift_id`'s row goes to `target_employee_id` and vice versa -
    the two employees' own assignments trade places, `assignment_source`
    becomes `swap` on both."""
    initiator_assignment = await _load_assignment_by_id(
        session, tenant_id=tenant_id, assignment_id=initiator_shift_id
    )
    target_assignment = await _load_assignment_by_id(
        session, tenant_id=tenant_id, assignment_id=target_shift_id
    )

    now = datetime.now(UTC)
    initiator_assignment.employee_id = target_employee_id
    initiator_assignment.assignment_source = "swap"
    initiator_assignment.updated_at = now
    target_assignment.employee_id = initiator_employee_id
    target_assignment.assignment_source = "swap"
    target_assignment.updated_at = now

    await _record_double_booking_if_any(
        session,
        tenant_id=tenant_id,
        schedule_id=initiator_assignment.schedule_id,
        assignment=initiator_assignment,
        now=now,
    )
    await _record_double_booking_if_any(
        session,
        tenant_id=tenant_id,
        schedule_id=target_assignment.schedule_id,
        assignment=target_assignment,
        now=now,
    )

    await session.flush()
    await session.refresh(initiator_assignment)
    await session.refresh(target_assignment)
    for assignment in (initiator_assignment, target_assignment):
        await nats_publisher.publish_assignment_changed(
            js,
            tenant_id=tenant_id,
            schedule_id=assignment.schedule_id,
            assignment_id=assignment.id,
            employee_id=assignment.employee_id,
            shift_start=assignment.shift_start,
            shift_end=assignment.shift_end,
            changed_at=now,
            reason="swap",
        )
    return initiator_assignment, target_assignment


async def list_conflicts(
    session: AsyncSession, *, tenant_id: uuid.UUID, schedule_id: uuid.UUID
) -> list[ScheduleConflict]:
    schedule = await session.scalar(
        select(Schedule).where(Schedule.tenant_id == tenant_id, Schedule.id == schedule_id)
    )
    if schedule is None:
        raise ScheduleByIdNotFoundError(str(schedule_id))
    return list(
        (
            await session.scalars(
                select(ScheduleConflict).where(
                    ScheduleConflict.tenant_id == tenant_id, ScheduleConflict.schedule_id == schedule_id
                )
            )
        ).all()
    )


async def resolve_conflict(
    session: AsyncSession, *, tenant_id: uuid.UUID, schedule_id: uuid.UUID, conflict_id: uuid.UUID, status: str
) -> ScheduleConflict:
    """`ScheduleConflictResponse`'s own doc comment claimed this mutation
    lived in the root service's GraphQL layer — it didn't (verified: no
    `resolveConflict` anywhere in that codebase), so conflicts were
    permanently read-only. Mirrors `AdherenceException`'s own
    open/acknowledged/resolved shape (intraday-service) rather than
    inventing a third vocabulary for the same "something needs attention,
    then it was handled" pattern."""
    conflict = await session.scalar(
        select(ScheduleConflict).where(
            ScheduleConflict.tenant_id == tenant_id,
            ScheduleConflict.schedule_id == schedule_id,
            ScheduleConflict.id == conflict_id,
        )
    )
    if conflict is None:
        raise ScheduleConflictNotFoundError(str(conflict_id))
    conflict.status = status
    conflict.updated_at = datetime.now(UTC)
    await session.flush()
    return conflict


async def audit_fairness(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    period_start: date,
    period_end: date,
    tolerance: int,
) -> tuple[dict[uuid.UUID, int], float]:
    """The compliance-auditor query the module prompt asks for by name:
    every employee who appears in the `FairnessLedger` within
    `[period_start, period_end)`, their undesirable-shift count in that
    window, and the group average to compare against. `tolerance` is the
    auditor's own question ("would this have violated tolerance N"), not
    auto-derived from historical `ScheduleJob.constraint_config` rows - see
    `FairnessAuditResponse`'s docstring for why."""
    period_start_dt = datetime(period_start.year, period_start.month, period_start.day, tzinfo=UTC)
    period_end_dt = datetime(period_end.year, period_end.month, period_end.day, tzinfo=UTC)
    result = await session.execute(
        select(FairnessLedger.employee_id, func.count())
        .where(
            FairnessLedger.tenant_id == tenant_id,
            FairnessLedger.is_undesirable.is_(True),
            FairnessLedger.shift_start >= period_start_dt,
            FairnessLedger.shift_start < period_end_dt,
        )
        .group_by(FairnessLedger.employee_id)
    )
    counts: dict[uuid.UUID, int] = {row[0]: row[1] for row in result.all()}
    average = (sum(counts.values()) / len(counts)) if counts else 0.0
    return counts, average


def exceeds_tolerance(count: int, average: float, tolerance: int) -> bool:
    return abs(count - average) > tolerance
