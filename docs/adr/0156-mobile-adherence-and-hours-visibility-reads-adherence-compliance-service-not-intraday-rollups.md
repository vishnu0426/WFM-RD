# ADR-0156: Mobile adherence/hours visibility reads adherence-compliance-service (Module 08), not intraday-service's own rollups; Hours, not Pay

## Context

Phase 7's entire spec text is one line: "Adherence/pay visibility
screens. Read-only surfaces against Module 08/existing payroll-adjacent
data (Module 06)." There is no payroll/compensation service anywhere in
this platform — "payroll-adjacent" can only mean whatever
attendance-leave-service (Module 06) actually has: worked hours (from
`AttendanceRecord`) and leave balances (`LeaveBalance`).

**A research correction was necessary before any design work could
start, verified directly against `package.json` descriptions**: Module
08 is `adherence-compliance-service`, not `intraday-service` (Module 05).
This isn't cosmetic — `adherence-compliance-service` owns `AdherenceScore`
(`compliance.adherence_score`), a real, precomputed, time-weighted
adherence percentage (`adherentSeconds / totalScheduledSeconds`),
refreshed every 15 minutes by a live `@Cron` job
(`AdherenceDailyRollupJobService`) for `periodType: 'day'`.
`intraday-service`'s own rollup tables (`AdherenceHourlyRollup`/
`AdherenceDailyRollup`) have no scheduled-time denominator at all — an
event-count ratio, not a true adherence percentage, and the wrong data
source for this phase. Neither table had a read endpoint of any kind
before this phase (confirmed by grep).

## Decision

**1. `adherenceScoreToday` (GraphQL, adherence-compliance-service) is
the "today's adherence %" source**, not intraday's own rollups. New
`EmployeeAdherenceScoreQueryService` + `AdherenceScoreResolver`, this
service's first per-employee (not roster-aggregate) read of
`AdherenceScore`. Returns `null`, not a fabricated `0%`, when no row
exists for `periodType: 'day'` covering "now" — that's the real "no
adherence activity recorded yet today" case (shift hasn't started, or no
activity-change event has landed yet), and `0%` would be
indistinguishable from "recorded and fully non-adherent." No `date`
argument on the query — bakes "today only" into the schema itself, not
just client discipline; a historical trend is a materially bigger future
feature.

**2. Transport is per-endpoint, not platform-uniform.** GraphQL for both
new adherence-compliance-service and (already-existing)
intraday-service queries, matching each service's own stated primary API
surface (`ComplianceGraphQLModule`'s own doc comment: "this service's
primary API surface"). REST for both new attendance-leave-service
endpoints, since that service has no GraphQL module at all
(`app.module.ts`'s own comment: "lands with whichever phase first needs
it" — no phase has). Mixed transport per-service is already normal in
this platform; matching each service's own convention is more consistent
than forcing one transport platform-wide.

**3. `graphqlRequest` (`mobile-app/src/api/client.ts`) gained an optional
`tenantId` parameter, sent as `X-Tenant-Id`.** It never sent this header
before Phase 7 — its only prior caller, `getMe()`, doesn't need it
(platform-core's `me` query derives identity from the bearer token). Both
new GraphQL calls in this phase need it, the same ADR-0014 header-trust
every REST endpoint in this platform already uses — without this fix,
both calls fail closed against `TenantContextMiddleware`. Backward
compatible: `getMe()`'s call passes no `tenantId`, unchanged.

**4. Neither new attendance-leave-service endpoint pre-aggregates in a
way that invents policy.** `GET /v1/attendance/employees/{employeeId}/records`
returns raw `AttendanceRecord[]` — a server-computed "total hours" would
bake in an unstated day-boundary/attribution policy this one-line spec
never answers (e.g. how to attribute an overnight shift); summation from
`clockInAt`/`clockOutAt` pairs is trivial and transparent client-side.
`GET /v1/leave/employees/{employeeId}/balances` **does** compute
`availableDays` server-side (`accruedDays - usedDays - pendingDays`) —
`LeaveBalance`'s own doc comment already says this was meant to be "a
GraphQL computed field added in a later phase, not a column"; this is
that phase, and computing it here avoids making the mobile client
reimplement arithmetic the entity's own author already assigned
server-side. Balances are filtered to periods covering today only — a
"my balance" screen is a narrow current-state need, not an audit trail.

**5. Cutoffs, both disclosed placeholders, not considered-correct
answers:** adherence is today-only (no trend); hours use a trailing
14-day window, symmetric with `useEmployeeShiftAssignments.ts`'s own real
`WINDOW_DAYS_AHEAD = 14` forward-looking window (backward instead of
forward) — there is no real pay-period concept anywhere in this platform
to derive a better window from.

**6. The tab is named "Hours," not "Pay."** A tab literally labeled
"Pay" that shows zero dollar amounts — because no payroll data exists
anywhere in this platform — is a foreseeable, avoidable trust problem.
"Hours" says exactly what's on the screen: hours worked and leave
balances, both genuinely time-denominated, never a payroll calculation
or pay-stub rendering.

**7. A still-open attendance record (`clockOutAt: null`) is excluded
from the computed hours total**, shown as a separate "Clocked in since
HH:MM — in progress" line. A static total figure that silently includes
an ever-growing open segment misrepresents its own precision on a
read-only, non-live screen with no ticking clock.

## Consequences

- No fix for the pre-existing employeeId-trust gap (ADR-0150, carried
  forward since Phase 3): nothing binds the signed-in session to the
  `employeeId` supplied on every call. Every new endpoint in this phase
  inherits it, same as every prior Module 11 phase's own endpoints.
- No supervisor/manager view — single-employee, self-service scope only,
  matching every other Module 11 tab.
- No auto-refresh/polling on either new screen — a visibility screen
  fetches once per view, it isn't a live dashboard.
- `intraday-service` itself is untouched this phase — `agentLiveState`
  already existed; this phase is simply its first real caller.
