# ADR-0064: scheduling-service gains an employee-scoped shift-assignment read endpoint and two publish-time NATS events, for Module 05

## Context
Module 05's `AgentLiveState.scheduled_activity` is required (§2.2 rule 2) to
be pre-loaded from Module 04's *published* `Schedule`, triggered off
`Schedule.published_at` combined with each employee's actual shift-start
time, and actively updated on a mid-shift schedule change. Auditing
scheduling-service as it stood through its own 8 completed phases found
neither half of what this requires: every existing endpoint
(`app/api/v1/jobs.py`, `app/api/v1/schedules.py`) is scoped by `job_id` or
`schedule_id` - nothing lets a caller ask "what is employee X scheduled to
do," and `app/events/nats_publisher.py` only ever published
`agno.scheduling.job.completed.v1` (a solver-completion signal, not a
publish-lifecycle one) - `schedule_service.publish_schedule` and
`override_assignment` emitted no event at all. Module 04's own gRPC surface
(ADR-0059) is entirely outbound (this service calls Module 01/02/03, never
the reverse), so there was no existing inbound contract of any kind to
extend either.

This is a genuine gap in the original cross-module design, not a bug -
Module 04's 8 phases were scoped and built before Module 05 existed. Rather
than have Module 05 read scheduling-service's Postgres schema directly
(which would violate the exact "no cross-schema reach, gRPC/REST contracts
only" boundary ADR-0052 established for this service) or work around the
gap with a stub, this ADR extends scheduling-service additively.

## Decision
**One new read endpoint**: `GET
/v1/scheduling/employees/{employeeId}/shift-assignments?from=&to=`
(`app/api/v1/employees.py`, backed by
`schedule_service.list_employee_shift_assignments`) - returns every
`ShiftAssignment` for that employee, joined to its `Schedule`, whose
`[shift_start, shift_end)` overlaps `[from, to)`, filtered to
`Schedule.status == 'published'` only (a draft schedule isn't real yet).
The join is on `schedule_id`, an intra-schema column already used the same
way by `list_conflicts` - this is a normal same-database join, not a
cross-module reach; the response (`EmployeeShiftAssignmentResponse`) adds
`schedule_id`/`published_at` to the existing `ShiftAssignmentResponse`
shape, since a caller here doesn't already know which schedule it's asking
about.

**Two new NATS events**, both under the existing `agno.scheduling.>`
wildcard `bootstrap_stream` already provisions (no stream config change
needed):
- `agno.scheduling.schedule.published.v1` - published from
  `publish_schedule`, payload `{tenantId, scheduleId, orgUnitId,
  publishedAt, employeeIds[]}` (every employee with an assignment on that
  schedule, so a consumer doesn't need a second call just to know who's
  affected). Dedup id `{scheduleId}:published` - safe because
  `publish_schedule` structurally rejects a second publish of the same
  schedule (`status != "draft"` check).
- `agno.scheduling.assignment.changed.v1` - published from
  `override_assignment`, payload `{tenantId, scheduleId, assignmentId,
  employeeId, shiftStart, shiftEnd, reason: "manual_override"}`. Dedup id
  `{assignmentId}:{changedAt}` - unlike schedule-published, the *same*
  assignment can legitimately be overridden more than once, so the dedup
  key has to vary per call, not just per assignment.

Both are published **before** the enclosing transaction commits, inside
`schedule_service.py` itself (not the router layer) - this exactly mirrors
`job_service.py`'s own already-shipped precedent
(`_publish(js, job)` called mid-transaction at `job_service.py:463,478,513,593`).
This phase does not revisit that ordering choice; it applies the existing
one consistently to two new call sites rather than introducing a second
convention.

`publish_schedule`/`override_assignment` each gain a required `js:
JetStreamContext` parameter, threaded from the router via the existing
`get_jetstream` FastAPI dependency (`app/api/deps.py`) - both route
handlers were the only callers, so this is mechanical, not a design change
to either function's existing behavior.

## Consequences
- `scheduled_activity` is necessarily coarse: `ShiftAssignment` carries only
  `shift_start`/`shift_end`/`skill_id`, no activity-code/queue field.
  Module 05 (ADR-0065) derives `scheduled_activity` as `"on_shift"` while
  `now` falls inside a returned assignment's window, `null` otherwise - not
  a rich per-queue/per-activity signal. Giving Module 05 that richer signal
  would require Module 04 to grow an activity-code data model it doesn't
  have today; out of scope for this ADR.
- This is Module 04's first inbound contract for another service to read
  its data (vs. Module 04 calling out over gRPC to Module 01/02/03,
  ADR-0059's direction) - a precedent for how a future cross-module read
  need against this service should be shaped: an additive REST endpoint
  plus/or a publish-time event, not a shared-schema read.
- `reoptimize_schedule` (async, worker-driven, ADR-0060) does **not** yet
  publish `assignment.changed.v1` for the shifts it moves - only the
  synchronous `override_assignment` path does. A re-optimization that
  reassigns employees without a human override in the loop will not
  immediately refresh those employees' `scheduled_activity` in Module 05;
  they'll still catch up via `ShiftStartPreloadSchedulerService`'s cron
  tick once their shift actually starts, just not the moment the
  re-optimization completes. Flagged, not silently dropped - closing this
  gap means wiring `app/worker.py`'s reoptimize-completion path into
  `nats_publisher`, deferred to a later phase rather than done here.
- Every existing scheduling-service endpoint's behavior is unchanged - this
  is purely additive; no migration, no schema change.
