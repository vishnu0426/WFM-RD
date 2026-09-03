"""Domain error hierarchy + the `{ error: { code, message, details } }` REST
envelope shape, reused verbatim from Module 01/02/03's convention (ADR-0015)
for cross-platform consistency - this is a convention match, not a
shared-code dependency (different language, nothing to import).
"""

from __future__ import annotations

from typing import Any


class DomainError(Exception):
    """Base class for every error this service raises deliberately (as opposed
    to an unexpected exception, which is left as a generic 500)."""

    code: str = "DOMAIN_ERROR"
    http_status: int = 400

    def __init__(self, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details = details or {}

    def to_envelope(self) -> dict[str, Any]:
        return {"error": {"code": self.code, "message": self.message, "details": self.details}}


class TenantContextMissingError(DomainError):
    code = "TENANT_CONTEXT_MISSING"
    http_status = 400

    def __init__(self) -> None:
        super().__init__("No tenant context bound to this request.")


class InvalidTenantIdError(DomainError):
    code = "INVALID_TENANT_ID"
    http_status = 400

    def __init__(self, raw_value: str) -> None:
        super().__init__(f"'{raw_value}' is not a valid tenant id.", {"value": raw_value})


class InvalidAuthenticationError(DomainError):
    """GAP-08 fix (enterprise readiness audit, 2026-08-18): raised by
    `TenantContextMiddleware` for a missing/malformed `Authorization` header
    or a JWT that fails signature/issuer/audience/expiry verification
    against the root platform-core service's JWKS."""

    code = "INVALID_AUTHENTICATION"
    http_status = 401

    def __init__(self, reason: str) -> None:
        super().__init__(f"Authentication failed: {reason}.")


class NotFoundError(DomainError):
    code = "NOT_FOUND"
    http_status = 404


class ScheduleJobNotFoundError(NotFoundError):
    def __init__(self, job_id: str) -> None:
        super().__init__(f"No schedule job with id '{job_id}'.", {"jobId": job_id})


class ScheduleNotFoundError(NotFoundError):
    """Raised by `GET /v1/scheduling/jobs/{jobId}/schedule` when the job
    exists but hasn't produced a `Schedule` yet - still `queued`, or
    resolved to `infeasible`/`failed` (§2.2 rule 2: a real, distinct outcome,
    not folded into "not found")."""

    def __init__(self, job_id: str) -> None:
        super().__init__(f"Schedule job '{job_id}' has no schedule yet.", {"jobId": job_id})


class InvalidShiftDefinitionError(DomainError):
    """§3.1's union-rule shift-template validation
    (`app.solver.model.ShiftViolatesUnionRulesError`), surfaced as a normal
    422 at the API boundary rather than a raw 500 - the shift itself was
    never valid to offer, independent of any employee or solve outcome."""

    code = "INVALID_SHIFT_DEFINITION"
    http_status = 422

    def __init__(self, shift_id: str, reason: str) -> None:
        super().__init__(
            f"Shift '{shift_id}' violates union rules: {reason}", {"shiftId": shift_id, "reason": reason}
        )


class UpstreamDataUnavailableError(DomainError):
    """Phase 6/ADR-0059 Decision 5: a mid-solve gRPC pull (`EmployeeService`/
    `PolicyService`/`ForecastService`) exhausted its retries against a
    genuinely transient failure (`UNAVAILABLE`/`DEADLINE_EXCEEDED`). Raised
    *before* any `ScheduleJob`/`IdempotencyKey` row is created - a client
    retrying the identical `POST` with the same `Idempotency-Key` once the
    upstream recovers is a fresh attempt, not a replay of a failure. `503`,
    not `500` - this is the caller's signal that retrying later is the
    correct response, not that this service is broken."""

    code = "UPSTREAM_DATA_UNAVAILABLE"
    http_status = 503

    def __init__(self, service: str, method: str, reason: str) -> None:
        super().__init__(
            f"{service}.{method} is currently unavailable: {reason}",
            {"service": service, "method": method, "reason": reason},
        )


class ShiftHeadcountUndeterminedError(DomainError):
    """Phase 6/ADR-0059: a shift omitted `requiredHeadcount` (asking this
    service to derive it from `ForecastService.GetForecastRequirements`),
    but either the forecast run wasn't found (doesn't exist, wrong tenant,
    not yet `completed`) or no forecast interval overlapping the shift's own
    `[start, end)` window has a computed `required_headcount` at all. A
    caller error to surface clearly - never silently defaulted to some
    guessed headcount, which could understaff a real shift without anyone
    noticing."""

    code = "SHIFT_HEADCOUNT_UNDETERMINED"
    http_status = 422

    def __init__(self, shift_id: str, reason: str) -> None:
        super().__init__(
            f"Shift '{shift_id}' omitted requiredHeadcount and it could not be derived: {reason}",
            {"shiftId": shift_id, "reason": reason},
        )


class ScheduleByIdNotFoundError(NotFoundError):
    """Raised by `POST /v1/scheduling/schedules/{scheduleId}/publish` -
    distinct from `ScheduleNotFoundError` (keyed by job id, "no schedule
    exists yet") because this one is keyed by schedule id directly ("this
    specific schedule doesn't exist/isn't yours")."""

    def __init__(self, schedule_id: str) -> None:
        super().__init__(f"No schedule with id '{schedule_id}'.", {"scheduleId": schedule_id})


class ScheduleNotPublishableError(DomainError):
    """§4.2's `publishSchedule` only ever transitions `draft` -> `published`
    once - re-publishing (or publishing an `archived` schedule) is a real
    state conflict, not a silent no-op that could double-write
    `FairnessLedger` rows for the same shifts."""

    code = "SCHEDULE_NOT_PUBLISHABLE"
    http_status = 409

    def __init__(self, schedule_id: str, current_status: str) -> None:
        super().__init__(
            f"Schedule '{schedule_id}' cannot be published from status '{current_status}' (must be 'draft').",
            {"scheduleId": schedule_id, "currentStatus": current_status},
        )


class ShiftAssignmentNotFoundError(NotFoundError):
    """Raised by the override endpoint when `assignmentId` doesn't name a
    real `ShiftAssignment` on the given schedule (wrong id, or an id that
    belongs to a different schedule/tenant)."""

    def __init__(self, schedule_id: str, assignment_id: str) -> None:
        super().__init__(
            f"No shift assignment '{assignment_id}' on schedule '{schedule_id}'.",
            {"scheduleId": schedule_id, "assignmentId": assignment_id},
        )


class ShiftAssignmentNotFoundByIdError(NotFoundError):
    """Module 07 Phase 5 (ADR-0089): raised by the marketplace-event NATS
    consumer, which only knows a `shift_assignment_id` (no `schedule_id` -
    Module 07 never stores one) - distinct from `ShiftAssignmentNotFoundError`,
    which is scoped to a specific schedule for the REST override endpoint."""

    def __init__(self, assignment_id: str) -> None:
        super().__init__(
            f"No shift assignment '{assignment_id}'.",
            {"assignmentId": assignment_id},
        )


class ScheduleArchivedError(DomainError):
    """§2.1's `Schedule.status` includes `archived` - once a schedule reaches
    that state it's a closed historical record, not something a manual
    override or re-optimization can still mutate. Distinct from
    `ScheduleNotPublishableError` (that one's about the `publish` transition
    specifically; this one blocks override/reoptimize on any schedule status
    other than `draft`/`published`)."""

    code = "SCHEDULE_ARCHIVED"
    http_status = 409

    def __init__(self, schedule_id: str) -> None:
        super().__init__(
            f"Schedule '{schedule_id}' is archived and can no longer be modified.",
            {"scheduleId": schedule_id},
        )


class LockedShiftMissingFromReoptimizeRequestError(DomainError):
    """§2.2 rule 1: every currently-locked (non-`auto_generated`)
    `ShiftAssignment` on this schedule must be re-fixed on *every*
    subsequent re-optimization. Reoptimize matches locked assignments to the
    request's own `shiftSlots` by `(start, end, requiredSkillId)` rather than
    by id (the original request-supplied shift id was never persisted - see
    the Phase 5 design doc's assumptions) - if a locked assignment's shift
    isn't present in the resupplied `shiftSlots`, that's a caller bug (the
    locked shift silently vanishing from the problem), not something this
    service can fix up on the caller's behalf."""

    code = "LOCKED_SHIFT_MISSING_FROM_REQUEST"
    http_status = 422

    def __init__(self, schedule_id: str, employee_id: str, shift_start: str, shift_end: str) -> None:
        super().__init__(
            f"Schedule '{schedule_id}' has a locked assignment for employee '{employee_id}' "
            f"on shift {shift_start}-{shift_end} that is missing from this reoptimize request's "
            "shiftSlots.",
            {
                "scheduleId": schedule_id,
                "employeeId": employee_id,
                "shiftStart": shift_start,
                "shiftEnd": shift_end,
            },
        )


class LockedAssignmentEmployeeMissingError(DomainError):
    """Wraps `app.solver.model.UnknownLockedAssignmentError` at the API
    boundary: a locked assignment's employee must also appear in this
    reoptimize request's own `roster` (ADR-0058's forced variable needs an
    `Employee` to build a decision variable for) - surfaced as a normal 422
    caller error, not a raw 500."""

    code = "LOCKED_ASSIGNMENT_EMPLOYEE_MISSING"
    http_status = 422

    def __init__(self, employee_id: str) -> None:
        super().__init__(
            f"Employee '{employee_id}' holds a locked assignment on this schedule but is missing "
            "from this reoptimize request's roster.",
            {"employeeId": employee_id},
        )


class ProjectRuleNotFoundError(NotFoundError):
    def __init__(self, rule_id: str) -> None:
        super().__init__(f"No project rule with id '{rule_id}'.", {"ruleId": rule_id})


class ScheduleConflictNotFoundError(NotFoundError):
    def __init__(self, conflict_id: str) -> None:
        super().__init__(f"No schedule conflict with id '{conflict_id}'.", {"conflictId": conflict_id})


class RelaxationNotAvailableError(DomainError):
    """§5 point 4's human-approval gate, the failure side:
    `POST /v1/scheduling/jobs/{jobId}/relaxation/approve` refuses to run
    unless the job is genuinely `infeasible` with a recorded, not-yet-
    approved, feasible relaxation option - covers "job isn't infeasible",
    "no relaxation was ever searched", "the search found nothing feasible",
    "already approved", and (defensively) "re-solving didn't reproduce the
    expected feasible result"."""

    code = "RELAXATION_NOT_AVAILABLE"
    http_status = 409

    def __init__(self, job_id: str, reason: str) -> None:
        super().__init__(
            f"Cannot approve a relaxation for schedule job '{job_id}': {reason}.",
            {"jobId": job_id, "reason": reason},
        )


STATUS_BY_CODE: dict[str, int] = {
    err.code: err.http_status
    for err in (
        TenantContextMissingError,
        InvalidTenantIdError,
        NotFoundError,
        InvalidShiftDefinitionError,
        ScheduleNotPublishableError,
        ScheduleArchivedError,
        LockedShiftMissingFromReoptimizeRequestError,
        LockedAssignmentEmployeeMissingError,
        RelaxationNotAvailableError,
        UpstreamDataUnavailableError,
        ShiftHeadcountUndeterminedError,
    )
}
