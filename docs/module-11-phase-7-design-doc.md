# Module 11 Phase 7 Design Doc — Adherence/Pay Visibility Screens

**Status:** Approved for implementation
**Owner:** Mobile / Employee Self-Service pod (Module 11)
**Scope:** Two new read-only tabs — Adherence (real-time status +
today's adherence %) and Hours (worked hours + leave balances). No
schema change anywhere — every new endpoint reads existing tables.

## Problem

The entire spec text for this phase is one line: "Adherence/pay
visibility screens. Read-only surfaces against Module 08/existing
payroll-adjacent data (Module 06)." There is no payroll/compensation
service anywhere in this platform, so "pay visibility" can only mean
whatever attendance-leave-service (Module 06) actually has: worked hours
and leave balances. A research correction was necessary before design
could start: Module 08 is adherence-compliance-service, not
intraday-service (Module 05) — verified directly against `package.json`
descriptions. This mattered architecturally: adherence-compliance-service
owns a real, precomputed, time-weighted adherence percentage
(`AdherenceScore`); intraday-service's own rollup tables have no
scheduled-time denominator and would have produced a coarser, wrong
metric. Neither had a per-employee read endpoint before this phase.

## Decision

See docs/adr/0156 for full reasoning; summarized:

- New `adherenceScoreToday(employeeId)` GraphQL query
  (adherence-compliance-service) — `EmployeeAdherenceScoreQueryService` +
  `AdherenceScoreResolver`, reading `AdherenceScore` for `periodType:
  'day'` covering "now." Returns `null` (not `0%`) when no activity has
  been recorded yet today.
- intraday-service's already-existing `agentLiveState(employeeId)` query
  is used for the first time by a real caller — no backend change there.
- Two new REST endpoints on attendance-leave-service:
  `GET /v1/attendance/employees/{employeeId}/records?from=&to=` (raw
  `AttendanceRecord[]`, no server-side hours summation) and
  `GET /v1/leave/employees/{employeeId}/balances` (current periods only,
  `availableDays` computed server-side).
- `mobile-app/src/api/client.ts`'s `graphqlRequest` gained an optional
  `tenantId` param (sent as `X-Tenant-Id`) — a real, previously-missing
  piece of plumbing needed for both new GraphQL calls to succeed against
  `TenantContextMiddleware`.
- Two new tabs, Adherence and Hours (not "Pay" — no payroll data exists
  anywhere in this platform), inserted after Marketplace, before Profile.
  Each screen has two independent sections (own query, own loading/
  error/empty/success state) — one section failing never blocks the
  other.
- Hours worked is summed client-side from raw records; a still-open
  record is excluded from the total and shown separately as "in
  progress." A trailing 14-day window (symmetric with
  `useEmployeeShiftAssignments.ts`'s own real 14-day forward window) is a
  disclosed placeholder — no real pay-period concept exists anywhere in
  this platform.
- Mobile app calls all three services directly (docs/adr/0146,
  Phase 1's scheduling-service precedent) — no mobile-ess-service
  indirection, since nothing here is gRPC-only.

## Blast radius

Additive across four codebases: `adherence-compliance-service`
(`AdherenceModule`/`ComplianceGraphQLModule` additions, no migration),
`attendance-leave-service` (`AttendanceModule`/`LeaveModule` additions,
no migration), `mobile-app` (two new tabs, five new `src/api/*` files,
`client.ts`'s `graphqlRequest` signature change — backward compatible,
three new env vars), `intraday-service` (untouched — `agentLiveState`
already existed). No existing endpoint's behavior changes.

## Rollback plan

Revert each backend service's additive module/controller/service wiring
(no migration to reverse). Revert `graphqlRequest`'s optional parameter
(safe — its only prior caller passed none). Revert the two new mobile
tabs, their `_layout.tsx` wiring, and the new `src/api/*`/`src/features/
adherence/`/`src/features/hours/` directories.

## Explicit assumptions

1. Module 08 = adherence-compliance-service, not intraday-service —
   verified against real source before any design work, not assumed.
2. No historical adherence trend — today only, by the query's own
   signature (no date argument). A future phase's own scope.
3. Hours use a disclosed, arbitrary trailing-14-day window — no real
   pay-period concept exists anywhere in this platform.
4. "Pay visibility" = hours + leave-balance visibility only — no
   payroll calculation, no currency, ever. The tab is named "Hours"
   specifically to prevent this misreading.
5. No fix for the employeeId-trust gap (ADR-0150) — every new endpoint
   inherits it, named not solved, same as every prior phase.
6. No auto-refresh/polling — a visibility screen, not a live dashboard.
7. A still-open attendance record is excluded from the hours total, shown
   separately — a static total silently including a growing open segment
   would misrepresent its own precision.

## Out of scope for this phase

- Supervisor/manager view of any other employee's data.
- A historical adherence trend/chart.
- Payroll calculation, pay-stub rendering, currency of any kind.
- A fix for the pre-existing employeeId-trust gap.
- Auto-refresh/polling on either new screen.
- Leave-type name display — no listing endpoint exists for
  `leaveTypeId` anywhere in the platform (the same confirmed gap
  Phase 4's `LeaveRequestScreen` already discloses); shown as a labeled
  id, not silently hidden.

## Verification

- `cd adherence-compliance-service && npm run lint && npm run typecheck && npm test`
  — 192 tests, including new `employee-adherence-score-query.service.spec.ts`
  (found-in-range, no-row-returns-null, boundary filtering).
- `cd attendance-leave-service && npm run lint && npm run typecheck && npm test`
  — 133 tests, including new `list-employee-attendance-records.service.spec.ts`,
  `list-employee-leave-balances.service.spec.ts`, and
  `leave-balance-summary.dto.spec.ts` (the `availableDays` computation).
- `cd mobile-app && npm run lint && npm run typecheck && npm test` — 63
  tests, including new `AdherenceScreen.test.tsx`/`HoursScreen.test.tsx`
  (independent loading/success/empty/error per section, degraded-freshness
  note, still-open-record handling, zero-balance empty state) and
  `computeHoursWorked.test.ts`. `npx expo export --platform web` bundle
  smoke test.
- Manual multi-service run: not performed in this environment, stated
  plainly, same as every prior phase.
