# ADR-0098: the adherence rollup reads Module 05's raw `adherence_event` table via `agno_migrator`, not the hourly/daily rollup tables via a dedicated `agno_intraday_app` connection — and computes only what today's coarse signal actually supports

## Context
ADR-0094 (Phase 1) decided this module's rollup source in the abstract —
direct Postgres read against Module 05's data, not NATS — and specifically
named `adherence_hourly_rollup`/`adherence_daily_rollup` as the tables to
query, via a dedicated connection authenticated as `agno_intraday_app`.
Implementing the actual rollup job (Phase 3) surfaced three problems with
that plan, all only visible once this module's own code needed to produce
a real number:

1. **Module 05's rollup tables are themselves mutable and re-aggregated
   retroactively.** `AdherenceRollupSchedulerService` (intraday-service)
   re-aggregates a trailing 2-hour/2-day window on every tick specifically
   to catch late-arriving events - meaning the value stored for a given
   hour/day can still change up to two ticks after that hour/day first
   appeared to be "final." Reading that table as this module's own source
   of truth would mean a `ComplianceReport` generated from an
   `AdherenceScore` computed today could silently disagree with the same
   report regenerated tomorrow for the identical period, once Module 05's
   own trailing-window correction lands - a direct violation of §0.5's
   defining correctness property ("the same report requested twice for the
   same period returns the same numbers").
2. **Module 05 has no 15-minute-granularity rollup - only hourly and
   daily.** This module's own §0.5 SLO table names a 15-minute rollup
   cadence; querying an hourly-refreshed source on a 15-minute tick would
   mean 3 of every 4 ticks re-read data that hasn't changed, and still
   couldn't reconstruct exact adherent/non-adherent *second* totals
   (the rollup tables store `total_events`/`total_deviation_seconds`
   counts, not the specific segment boundaries needed to attribute
   seconds within an arbitrary period window).
3. **No dedicated `agno_intraday_app` connection is actually needed.**
   Module 05's data lives in the *same* `agno_wfm` database this module
   already connects to for its own schema - not a separate database.
   `agno_migrator` already owns every schema in this database, `intraday`
   included, and structurally bypasses RLS as each table's owner - exactly
   the mechanism Module 05's own two schedulers
   (`AdherenceRollupSchedulerService`/`AdherencePartitionSchedulerService`)
   already use for their own cross-tenant ticks. Provisioning a second
   role/credential for this module to hold would be new infrastructure with
   no advantage over reusing a credential this service already holds for
   its own migrations.

A fourth, more fundamental question surfaced during implementation:
**what does "adherent" actually mean, given the data Module 05 actually
produces?** ADR-0067 (Module 05) already settled this as coarsely as
possible - adherent means `scheduled_activity === 'on_shift'`, non-adherent
means anything else, with no richer activity taxonomy available anywhere
upstream. A direct consequence, not previously stated because no consumer
had needed to state it: **this signal can only ever detect unscheduled
activity (an event firing while not scheduled to be on shift) - it cannot
detect a no-show (an employee who is scheduled but generates zero events
for the entire shift).** An event-driven pipeline structurally cannot see
the absence of events; detecting "scheduled but never showed up" would
require comparing against Module 04's actual `ShiftAssignment` boundaries,
a capability this module has no gRPC client for and is not building in this
phase (mirrors ADR-0076's precedent for a different confirmed capability
gap: name it precisely, do not fabricate a result to fill it).

## Decision

**Source**: query `intraday.adherence_event` directly, via this module's
own `migratorPoolProvider` (own copy of intraday-service's/attendance-leave-service's
identical file) - the same `DB_MIGRATION_USERNAME`/`DB_MIGRATION_PASSWORD`
credentials this service already holds for `npm run migration:run`, reused
for a second, disclosed purpose (a cross-tenant analytical read), exactly
the "legitimate exception to the least-privilege runtime role" class
`migrator-pool.provider.ts`'s own doc comment in every prior service names.
No new role, no new connection config, no `INTRADAY_DB_*` environment
variables (an earlier draft of `.env.example` declared
`INTRADAY_DB_READONLY_USERNAME=agno_intraday_app` before this was worked
out - removed).

**Calculation** (own copy of ADR-0067's honesty posture, restated for this
module's own aggregation): for each `(tenant_id, employee_id)`, within a
period window, order that employee's `adherence_event` rows by timestamp
and attribute the duration between consecutive events to the *earlier*
event's own `scheduled_activity` value - adherent if `'on_shift'`,
non-adherent otherwise (`LEAD()` window function, one pass, no
per-employee loop). A segment already in progress at the period's start
contributes nothing to that period; a segment still open at the period's
end is closed off exactly at that boundary. Each period (day/week/month) is
accounted independently - segments are never carried across a period
boundary. `adherentSeconds`/`totalScheduledSeconds` are what this
computation can actually support: **`totalScheduledSeconds` means "total
observed activity-covered time," not "total time this employee was really
scheduled to work" (that would require Module 04's real shift boundaries).
A no-show contributes nothing to either the numerator or the denominator -
it is invisible to this computation, not scored as 0% adherent.**
`majorDeviationCount` counts non-adherent segments at or above
`ADHERENCE_MAJOR_DEVIATION_THRESHOLD_SECONDS` (flat env config, same
placeholder-default posture as attendance-leave's `ATTENDANCE_LATE_GRACE_MINUTES`).
A `(tenant, employee, day)` with zero events in the period is skipped
entirely - no row is written, rather than writing a fabricated 0/0 or
defaulting to some other number no observation actually supports.

**Scope for this phase**: only `period_type = 'day'` is computed directly
from `adherence_event` (15-minute cron, `AdherenceDailyRollupJobService`,
trailing 2-day window - same "re-aggregate the trailing window to catch
late arrivals" posture as Module 05's own scheduler).
`period_type = 'week'`/`'month'` are computed by a second, once-daily job
(`AdherenceWeeklyMonthlyRollupJobService`) that aggregates already-computed
`'day'` rows within `compliance.adherence_score` itself - never re-queries
`adherence_event` directly - which is both cheaper and guarantees a
week/month total is always exactly consistent with the days that compose
it. **`period_type = 'shift'` is not computed in this phase at all** -
Module 05 exposes no shift-boundary data richer than the coarse
`on_shift`/`null` boolean (ADR-0064/0067's own stated ceiling), so there is
no way for this module to know where one shift ends and the next begins
without a Module 04 client this phase does not build.

**Explicitly not attempted in this phase, for the same confirmed-capability-gap
reasons**: `OccupancyRecord`/`ShrinkageRecord`. Two independent, confirmed
gaps, not one narrow missing field - (a) no activity-category taxonomy
exists anywhere upstream richer than `on_shift`/`null` (nothing to map to
`talkTimeSeconds`/`acwSeconds`/`availableSeconds` or a shrinkage
`category`), and (b) `org.EmployeeService`'s full `.proto` surface (read in
full before writing this ADR) has no employee-id→org-unit-id lookup of any
kind - only org-unit→employees (`GetSchedulableEmployees`) and
employee-ids→skills (`GetEmployeeSkillMatrix`). Building either half would
require new capability in a different module (a richer intraday activity
taxonomy, or a new `EmployeeService` RPC) - not something this phase can
build around. Mirrors ADR-0076's precedent exactly: name the gap, don't
fabricate a result, say what closing it actually requires.

**Update, same phase (ADR-0099):** gap (b) above turned out to be narrow
enough to close within this phase after all - `EmployeeService.GetEmployeeOrgUnits`
now exists, and this module's own timezone-resolution work (needed for the
UTC-boundary problem this section originally accepted) already builds the
employee→org-unit resolution `OccupancyRecord`/`ShrinkageRecord` would also
need. Gap (a) - no activity-category taxonomy - is unaffected and remains
exactly as blocked as stated above; `OccupancyRecord`/`ShrinkageRecord`
still are not populated by this phase's code, now for one confirmed reason
instead of two.

**Day/week/month boundaries are UTC calendar boundaries, computed in
Node** (`Date.UTC(...)`), passed to Postgres as explicit `timestamptz`
parameters compared against `"timestamp" >= $1 AND "timestamp" < $2` -
never a Postgres-side `date_trunc('day', ...)` on the raw column. This
matters because `date_trunc` on a `timestamptz` truncates in the
*connecting session's* timezone, not UTC - confirmed on this platform's own
local dev Postgres, whose session timezone is `Asia/Kolkata`, not UTC. A
day boundary computed via `date_trunc` would therefore silently shift by
whatever offset the connecting session happens to have, and disagree with
this module's own JS-computed boundary the moment session timezone and
UTC diverge. Passing pre-computed UTC instants as parameters sidesteps this
entirely - a `timestamptz` value is an absolute instant regardless of
session timezone; only its *display* formatting and `date_trunc`'s own
truncation logic are timezone-sensitive. One direct consequence: `'day'`
in this module means the UTC calendar day, not any given tenant's local
calendar day - a disclosed simplification, not a per-tenant-timezone-aware
feature, since nothing in this module's own schema carries a tenant
timezone to be aware of in the first place.

**Amended by ADR-0099** (same phase, later the same day): the
"nothing... carries a tenant timezone to be aware of" premise above turned
out to be wrong - `org.employees.org_unit_id` and `org.org_units.timezone`
(via `org.working_time_calendars`) both already exist, real and populated;
the only actual gap was a missing RPC to reach them. ADR-0099 closes that
gap and replaces the UTC-uniform boundary computation described here with
a real per-employee IANA-timezone one, using Postgres's own `AT TIME ZONE`
operator rather than JS `Date.UTC(...)`. This section is left as written
for the historical record of what Phase 3's first cut actually shipped and
why - not corrected in place - see ADR-0099 for the current design.

## Consequences
- `AdherenceScore` rows this phase produces measure "did this employee do
  anything while not scheduled to be on shift" - a real, useful, but
  partial signal. A supervisor or compliance officer reading
  `adherencePct` must understand it does **not** capture no-shows; a
  future phase adding real Module 04 shift-boundary comparison would change
  what this number means, not just add precision to it - that phase should
  treat this as a breaking semantic change worth its own migration note,
  not a silent refinement.
- No `OccupancyRecord`/`ShrinkageRecord` row is ever written by this
  phase's code. Both tables exist (Phase 1's migration) and remain fully
  unpopulated - `GET`/`occupancyTrend`/`shrinkageBreakdown` (whichever
  phase eventually builds them) will return empty results honestly, not
  wrong ones, until the two capability gaps above close.
- `docs/module-08-phase-3-production-readiness-checklist.md` lists both
  gaps as explicitly not done, the same honesty standard ADR-0076 set for
  attendance-leave-service's own missing org-coverage capability.
- If a future phase decides to build the Module 04 shift-boundary client or
  the Module 02 employee→org-unit RPC, that is new, separately-scoped
  cross-module work requiring its own ADR - this one only commits to "name
  the gap, don't fabricate a result," not to a timeline for closing it.
