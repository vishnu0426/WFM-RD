# ADR-0099: `EmployeeService.GetEmployeeOrgUnits` closes Module 08's employee→org-unit gap, enabling real per-employee timezone resolution

## Context
ADR-0098 (Module 08 Phase 3) disclosed a real limitation rather than papering
over it: the adherence rollup computed `'day'`/`'week'`/`'month'` boundaries
as UTC calendar boundaries uniformly, for every tenant and every employee,
because nothing in this module's own reachable data carried a tenant or
employee timezone. That ADR named the two things closing the gap would
require: (1) a real activity-category/timezone signal, and (2) an
employee→org-unit lookup this platform had never built, since
`org.EmployeeService`'s full `.proto` surface (read in full at the time) had
only org-unit→employees (`GetSchedulableEmployees`) and employee-ids→skills
(`GetEmployeeSkillMatrix`) - never the reverse lookup this module actually
needs.

Unlike ADR-0076's org-coverage gap (no data model exists anywhere for
"minimum staffing") or the occupancy/shrinkage activity-taxonomy half of
ADR-0098's own gap (no richer activity signal exists anywhere upstream),
this half of the gap is **not** a missing data model - `org.employees.org_unit_id`
and `org.org_units.timezone` both already exist, real and populated
(`src/modules/employee/entities/employee.entity.ts`,
`src/modules/org-unit/entities/org-unit.entity.ts`). The gap is narrow: a
missing RPC over data that already exists, mirroring ADR-0059's original
framing of Module 04's leave-data gap ("a real table with no read endpoint
yet") rather than ADR-0076's "the complete absence of the underlying data
model." A narrow gap like this is exactly the kind this platform's own
precedent (ADR-0078, ADR-0082) closes by adding the missing RPC, not by
declaring it permanently out of reach.

## Decision
Add `EmployeeService.GetEmployeeOrgUnits(tenant_id, employee_ids) ->
{entries: {employee_id, org_unit_id}[]}` to core's existing `employee.proto`/
`EmployeeGrpcController` - sparse, batched, same shape as the adjacent
`GetEmployeeSkillMatrix` (an id with no matching employee is simply absent
from the response, not an error). Backed by a new
`EmployeesRepository.findByIds(employeeIds)` query
(`employee_id = ANY(:employeeIds)`, tenant-scoped via
`TenantScopedRepository`/RLS, same pattern `EmployeeSkillsRepository.findForEmployees`
already uses for the sibling RPC).

Module 08 (`adherence-compliance-service`) gets two new gRPC clients,
own copies of this platform's existing patterns:
- `EmployeeGrpcClientModule`/`Service` (own copy of shift-marketplace-service's,
  calling `GetEmployeeOrgUnits` instead of `GetSchedulableEmployees`).
- `CalendarGrpcClientModule`/`Service` (exact copy of attendance-leave-service's,
  calling the already-existing `CalendarService.GetWorkingTimeRules` for
  `.timezone`, keyed by `org_unit_id` - no core-side change needed for this
  half, since `GetWorkingTimeRules` already accepts one).

A `TimezoneResolverService` (Module 08's own, `src/adherence/timezone-resolver.service.ts`)
composes the two calls: `employeeId -> orgUnitId` (batched per tenant) then
`orgUnitId -> timezone` (deduplicated - employees sharing an org unit share
one `GetWorkingTimeRules` call, not one per employee), with an in-memory
cache (TTL, keyed by `(tenantId, orgUnitId)`) so a 15-minute rollup tick
does not re-issue a full gRPC round trip for every org unit on every tick.
An employee whose org unit cannot be resolved (either RPC unavailable, or
no matching row) falls back to UTC, logged, never silently dropped from
the rollup entirely - a degraded-but-correct posture, not a missing one
(mirrors this module's own "no calendar configured" precedent for
`CalendarGrpcClientService.getWorkingTimeRules` in attendance-leave-service:
absence of a signal is not treated as absence of the employee).

## Consequences
- This is Module 08's first gRPC client of any kind, and core's
  `EmployeeService`/`CalendarService` gain their first Module-08 consumer.
  `GRPC_URL`/`CORE_GRPC_URL` env vars (already declared, unused, in Phase 1's
  `.env.example`) are wired to something real for the first time this phase.
- `AdherenceDailyRollupJobService`'s single "one query, every tenant, one
  UTC day" shape becomes "resolve timezones for employees active in the
  window, group by resolved timezone, run one query per distinct timezone
  group with period boundaries computed in that timezone." More queries per
  tick than before, bounded by the number of *distinct* timezones actually
  in play across the whole platform (small in practice), not by tenant or
  employee count.
- `'day'`/`'week'`/`'month'` now mean each employee's own local calendar
  day/week/month (their resolved org unit's timezone), not a platform-wide
  UTC one. This is a real semantic change to numbers this module has
  already computed and stored in Phase 3's own verification runs - existing
  rows computed under the old UTC-uniform logic are stale relative to the
  new definition and would only be corrected by a future rollup tick
  re-touching their period (the existing trailing-window re-aggregation
  already does this for anything within its window; anything outside it
  keeps its old, UTC-computed value until explicitly reprocessed - not a
  concern for this phase's own verification data, which is disposable
  fixture data, but worth stating plainly rather than silently implying
  every historical row is automatically correct after this change).
- Two independent points of external unavailability now exist in this
  job's own path (core's gRPC server, for both RPCs) where none did
  before. Both fail toward the disclosed UTC fallback per employee, not
  toward failing the whole tick - a job whose entire value is "runs
  reliably every 15 minutes" should not go dark because one org unit's
  timezone lookup timed out.
- Closing the *other* half of ADR-0098's gap (occupancy/shrinkage's missing
  activity taxonomy) remains exactly as blocked as ADR-0098 stated - this
  ADR closes the org-unit/timezone half only, because that half turned out
  to be a narrow missing RPC over existing data, not a missing data model.
