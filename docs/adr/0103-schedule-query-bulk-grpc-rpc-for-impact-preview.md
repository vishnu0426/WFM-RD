# ADR-0103: scheduling-service gains a bulk `ScheduleQueryService.ListPublishedShiftAssignments` gRPC RPC for Module 08's `RuleChangeImpactPreview`

## Context
Module 08 Phase 5 (§7, §5a) needs to "re-run the constraint check against
currently-published schedules" for a proposed `ComplianceRule` change - a
real simulation, not a placeholder. That requires, for a set of employees
and a date window, every one of their currently-published `ShiftAssignment`
rows.

The only existing read contract for this data is
`GET /v1/scheduling/employees/{employeeId}/shift-assignments`
(docs/adr/0064) - single-employee REST. There is no precedent anywhere in
this platform for a Node service calling another service's REST API in
either direction; every cross-service call, in both directions, is gRPC
(`AuditGrpcClientModule`, `SchedulingEligibilityGrpcClientModule`,
Module 08's own `EmployeeGrpcClientModule`/`CalendarGrpcClientModule`, etc).
Looping N sequential REST calls from Node - one per employee in an org
unit's roster - would both invent a new cross-service transport pattern and
be needlessly slow for a preview that can span a whole org unit.

## Decision
A second gRPC server surface in scheduling-service (`schedule_query.proto`,
`ScheduleQueryService.ListPublishedShiftAssignments`) - this service's first
was `scheduling_eligibility.proto` (ADR-0082). Server-streaming, same
"don't buffer an unbounded response" rationale as `employee.proto`'s
`GetSchedulableEmployees`: a multi-week window across a large roster is a
lot of rows. Request takes `tenant_id` + `employee_ids` (repeated) +
`window_start`/`window_end`; response includes `schedule_id` per row so the
caller can populate `RuleChangeImpactPreview.simulatedAgainstScheduleIds`
without a second lookup.

Backed by a new `list_shift_assignments_for_employees` query
(`app/services/schedule_service.py`) - the exact same "published schedule
only, window-overlap" filter `list_employee_shift_assignments` already
uses, generalized from one `employee_id` to an `employee_id IN (...)` list.
Not a rewrite: same join, same filter predicate, same ordering column
family (now `employee_id, shift_start` so the caller can group consecutive
stream messages per employee without buffering the whole stream first).

Hosted in the same process/port as `SchedulingEligibilityServicer`
(`settings.scheduling_grpc_bind_address`) - neither servicer touches
CP-SAT/`solve()`, so neither is the CPU-bound work ADR-0060 moved onto
`app/worker.py`.

No dedicated automated test exists for `ScheduleQueryServicer` itself,
matching the established precedent: `SchedulingEligibilityServicer` has no
test of its own either, only the pure logic underneath it does. The new
bulk query function (the actually-new logic) is covered by
`tests/integration/test_schedule_query_grpc.py` against a real Postgres;
the servicer wrapper is additionally exercised there directly (as an
async generator, in-process) for one happy-path and one malformed-request
case, going slightly beyond the `SchedulingEligibilityServicer` precedent
since a bulk streaming RPC has more surface (grouping, malformed-UUID
handling) worth pinning down.

## Consequences
- Module 08 gains a third outbound gRPC client (after `EmployeeGrpcClientModule`/
  `CalendarGrpcClientModule`, both pointed at core) - `SCHEDULING_GRPC_URL`
  (default `localhost:8102`, matching scheduling-service's own bind
  default and shift-marketplace-service's identical client's existing
  convention).
- An org unit with an empty roster or zero published assignments in the
  window returns an empty stream, not an error - both `generateImpactPreview`
  and this RPC treat "nothing to simulate" as a normal, zero-count result.
- This local dev environment's `scheduling-service/.env` had drifted from
  `.env.example` (`DB_PORT=5433`/`DB_USERNAME=postgres`/`DB_PASSWORD=admin`,
  none of which match this machine's actual Postgres role/port) - found
  and fixed while verifying this RPC end to end, unrelated to this ADR's
  own decision but required before any integration test in this service
  could run for real on this machine. attendance-leave-service's
  migrations were also found un-applied on this machine (`GetUnavailability`
  failing with `relation "attendance_leave.leave_request" does not exist`) -
  run for real (`npm run migration:run`) rather than worked around, since
  scheduling-service's solve pipeline has called that RPC unconditionally
  since ADR-0059/Phase 6.
