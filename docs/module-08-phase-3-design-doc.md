# Module 08 Phase 3 Design Doc — Adherence & Compliance: Rollup Jobs

**Status:** Approved for implementation
**Owner:** Adherence & Compliance pod (Module 08).
**Scope:** §7's own Phase 3 line: "Idempotent, resumable adherence/
occupancy/shrinkage rollups reading from Module 05's Postgres output; the
reproducibility test from §0.5." Concretely: two `@nestjs/schedule` cron
jobs computing `AdherenceScore` rows for `period_type = 'day'` (15-minute
cadence, reading Module 05's raw `intraday.adherence_event` table) and
`period_type = 'week'`/`'month'` (once-daily cadence, aggregating this
module's own already-computed `'day'` rows) — plus the §0.5 reproducibility
test itself, computed per each employee's own real IANA timezone (ADR-0099,
added the same day after ADR-0098's own first cut assumed UTC uniformly —
see the Addendum below). **`period_type = 'shift'`, `OccupancyRecord`, and
`ShrinkageRecord` are explicitly not built in this phase** — see ADR-0098.

## Problem

Implementing the rollup job for real surfaced that Phase 1's ADR-0094 —
"read Module 05's Postgres rollup tables" — didn't survive contact with
what those tables actually contain, and that most of §7's own literal ask
("occupancy/shrinkage rollups") is blocked on capabilities that do not
exist anywhere else in this platform yet. Four real findings, in the order
they surfaced:

1. **Module 05's `adherence_hourly_rollup`/`adherence_daily_rollup` are
   themselves mutable** — `AdherenceRollupSchedulerService` (intraday-service)
   re-aggregates a trailing window on every tick specifically to catch
   late-arriving events, meaning a value read today can silently change
   once that trailing window catches up. Reading them as this module's own
   source would let a `ComplianceReport` disagree with itself on
   regeneration — the exact failure §0.5's reproducibility property rules
   out.
2. **Module 05 has no 15-minute rollup, only hourly/daily**, and neither
   stores the per-event `scheduled_activity`/timestamp detail this
   module's own second-level accounting needs.
3. **No new role or connection was actually required.** Module 05's data
   lives in the same `agno_wfm` database this service already connects to;
   `agno_migrator` already owns every schema in it, `intraday` included,
   and Module 05's own two schedulers already use exactly this mechanism
   for their own cross-tenant ticks. Phase 1's `INTRADAY_DB_READONLY_*`
   plan was solving a problem that didn't exist.
4. **Occupancy/shrinkage need data this platform does not have anywhere**:
   no activity-category taxonomy richer than `on_shift`/`null` exists
   upstream (ADR-0067's own stated ceiling), and `org.EmployeeService`'s
   full `.proto` surface — read in full before writing ADR-0098 — has no
   employee-id→org-unit-id lookup of any kind.

ADR-0098 resolves all four, revising ADR-0094's source decision and
committing to what this phase can honestly build.

## Decision

**`AdherenceDailyRollupJobService`** (`src/adherence/adherence-daily-rollup-job.service.ts`):
`@Cron('*/15 * * * *')`. Re-aggregates a trailing window (today +
`ADHERENCE_DAILY_ROLLUP_TRAILING_DAYS`, default 2 prior days — same
"trailing window on every tick, not since-last-tick" posture as Module
05's own scheduler) one calendar day at a time. For each day, one SQL
statement: a `LEAD()` window function over `intraday.adherence_event`
(ordered per employee) attributes the duration between consecutive events
to the *earlier* event's own `scheduled_activity` — adherent iff
`'on_shift'` (ADR-0067's definition, unchanged) — then `INSERT ... SELECT
... GROUP BY tenant_id, employee_id ... ON CONFLICT (tenant_id,
employee_id, period_type, period_start) DO UPDATE` into
`compliance.adherence_score`. Runs via `MIGRATOR_PG_POOL` (this service's
own copy of `migrator-pool.provider.ts`, added this phase). A
`(tenant, employee, day)` with zero events produces no row — no fabricated
0/0. `majorDeviationCount` counts non-adherent segments at or above
`ADHERENCE_MAJOR_DEVIATION_THRESHOLD_SECONDS` (default 300s).

**`AdherenceWeeklyMonthlyRollupJobService`** (`src/adherence/adherence-weekly-monthly-rollup-job.service.ts`):
`@Cron('30 1 * * *')`, once daily. Aggregates already-computed `'day'` rows
(never re-queries `adherence_event`) into `'week'`/`'month'` rows over a
trailing window (default 35 days, `ADHERENCE_WEEKLY_MONTHLY_ROLLUP_TRAILING_DAYS`).
The naive `now - trailingDays` cutoff is rounded back to the Monday
on-or-before the containing month's own start — a real bug caught during
implementation (not by running the query, by hand-verifying the boundary
math): a raw cutoff can land mid-week or mid-month, which would aggregate
that boundary period from only *some* of its constituent day-rows —
silently wrong, not just "not yet computed." Three unit tests
(`adherence-weekly-monthly-rollup-job.service.spec.ts`) assert the exact
rounding for three different month-start weekdays.

**Both jobs are idempotent/resumable by construction** (§2.2 rule 4): the
`ON CONFLICT ... DO UPDATE` target is the exact unique key Phase 1's
migration already defined, so a crash mid-tick, a redelivered NATS-style
retry (not applicable here, but the same principle), or simply the next
scheduled tick re-running the identical window converges on the same
stored values — never a duplicate row, never drift from re-running.

**The §0.5 reproducibility test** (`test/integration/adherence-rollup-reproducibility.spec.ts`,
this service's first `test/integration/` directory — deferred out of Phase
1 for the same "no request path existed yet" reason attendance-leave's own
Phase 1 flagged): seeds four hand-chosen `adherence_event` rows against a
real local Postgres (requires both this service's own migration *and*
intraday-service's own migration already applied), runs the daily tick
twice, and asserts the resulting row's `id` and every computed number are
byte-identical across both runs while `computed_at` strictly advances —
proving the tick actually re-ran the computation rather than skipping it.
Caught a real off-by-one in the test's own hand-computed expected values on
first attempt (each segment is attributed to the *earlier* event's
`scheduled_activity`, not the later one) — fixed by re-deriving the
expected numbers correctly, not by changing the implementation to match a
wrong expectation.

**UTC day/week/month boundaries, computed in Node** (`Date.UTC(...)`), was
this section's first-cut design (ADR-0098) — passed to Postgres as
explicit `timestamptz` query parameters, never a Postgres-side
`date_trunc('day', ...)` on the raw column (which truncates in the
*connecting session's* timezone, not UTC — confirmed on this platform's
own local dev Postgres, session timezone `Asia/Kolkata`, and caught during
manual real-Postgres verification: a hand-seeded row using
`date_trunc('day', now())` in `psql` produced a different, smaller result
than the automated test's JS-computed UTC boundaries — not a code defect,
just a fact worth disclosing). **Superseded the same day by ADR-0099** —
see the Addendum below for the real per-employee-timezone design that
actually shipped.

## Addendum: real per-employee timezone support (ADR-0099)

The UTC-uniform design above was checked against the user's own explicit
ask ("support all country timezones") and found wanting - and, on
investigation, wrong on its own stated premise: `org.employees.org_unit_id`
and `org.org_units.timezone` (via `org.working_time_calendars`) already
exist, real and populated. The only actual gap was a missing RPC
(`EmployeeService.GetEmployeeOrgUnits`) to reach that data - a narrow gap,
not a missing data model, mirroring ADR-0059's framing rather than
ADR-0076's. ADR-0099 closes it:

- **Core (root `src/`) gains one new RPC**: `EmployeeService.GetEmployeeOrgUnits`
  (`employee.proto`, `EmployeeGrpcController`, backed by a new
  `EmployeesRepository.findByIds`) - sparse, batched, same shape as the
  adjacent `GetEmployeeSkillMatrix`.
- **This service gains its first two gRPC clients**: `EmployeeGrpcClientModule`
  (calls the new RPC) and `CalendarGrpcClientModule` (calls core's
  already-existing `CalendarService.GetWorkingTimeRules` for `.timezone`,
  keyed by the resolved `orgUnitId`).
- **`TimezoneResolverService`** composes both, deduplicating the calendar
  call across employees sharing an org unit, caching `orgUnit → timezone`
  (1h TTL - org-unit timezones essentially never change) but never caching
  `employee → orgUnit` (real, mutable, always resolved fresh). Falls back
  to `'UTC'` per employee - logged, never silent, never failing the whole
  tick - if either RPC is unavailable.
- **Both rollup queries were rewritten around Postgres's own `AT TIME ZONE`
  operator** rather than JS-computed UTC boundaries: `"timestamp" AT TIME
  ZONE $tz` converts an absolute instant to that employee's real IANA
  timezone's wall-clock time (DST-correct, using Postgres's own tzdata),
  `date_trunc('day'/'week'/'month', ...)` buckets it, and converting back
  through the same `AT TIME ZONE $tz` yields the correct UTC instant for
  that employee's own local period boundary - validated by hand against
  Postgres directly (`Asia/Kolkata` and `America/New_York` round-trips)
  before being wired into either service. Both queries now handle every
  local day/week/month a `(tenant, timezone)` group's employees touch in
  one pass (`GROUP BY ... local_day` / `date_trunc(..., period_start AT
  TIME ZONE $tz)`) - no per-day loop needed anymore.

**A real bug surfaced during E2E verification, not by any unit test**:
after wiring two employees to org units in `Asia/Kolkata` and
`Europe/London` and running the full pipeline against a real, freshly
booted core gRPC server, both employees' computed `period_start` landed on
a *UTC* midnight, not their own local one - indistinguishable from the
old, superseded UTC design. Isolated `AT TIME ZONE` reproductions in raw
`psql` and via a raw `pg.Pool` both computed the correct value; the actual
`TimezoneResolverService.resolveTimezones` call, traced directly, revealed
why: `CalendarService.GetWorkingTimeRules` was returning `timezone: 'UTC'`
for both org units, silently (no thrown error, no fallback warning,
because the RPC call itself succeeded) - because a `WorkingTimeCalendar`
row only existed as the tenant-wide default, not per org unit, and core's
own `timezone` column defaults to `'UTC'` when nothing more specific is
configured. Not a bug in this module's code at all - a genuinely
incomplete test fixture (missing `org.working_time_calendars` rows for the
two test org units). Fixed by seeding them; re-running produced exactly
correct, independent local-midnight boundaries for both employees,
confirmed against `period_start AT TIME ZONE <that employee's own real
timezone>` directly. Worth recording precisely because "the RPC call
succeeded but returned a default value" is a failure mode neither
exception handling nor a fallback-and-log posture can catch - only
checking the *value*, not just the *success*, of an external call would
have.

## Blast radius
- New files only: `src/adherence/` gains its two job services and module;
  `src/database/migrator-pool.provider.ts` and
  `src/common/config/get-number-config.ts` are new (both own copies of
  existing platform patterns). `app.module.ts` gains `ScheduleModule.forRoot()`
  and `AdherenceModule` — additive. `package.json` gains `@nestjs/schedule`.
  `.env.example` drops the never-actually-needed `INTRADAY_DB_READONLY_*`
  vars and adds rollup-tuning config.
- No migration in this phase — Phase 1's schema already has every column
  and unique constraint this phase's SQL depends on.
- Two new ADRs (0098, revising 0094's source decision; 0099, revising
  0098's own UTC-boundary decision the same day). Neither prior ADR is
  edited in place — each gains a short forward-reference note instead,
  this platform's own convention for a later ADR revising an earlier one.
- Ran `intraday-service`'s own `npm run migration:run` against this local
  Postgres for the first time (it had never been applied before this
  phase's own verification needed real `adherence_event` data to exist) —
  a real, necessary, additive step; no schema this phase owns was touched
  by that migration.
- **ADR-0099's own blast radius, additional to the above**: root `src/`
  gains one new gRPC RPC (`EmployeeService.GetEmployeeOrgUnits`) and one
  new repository method (`EmployeesRepository.findByIds`) — additive only,
  no existing RPC or method changed. This service gains
  `src/grpc/employee-grpc-client.*`, `src/grpc/calendar-grpc-client.*`, and
  `src/adherence/timezone-resolver.service.ts`. Also ran root's own `npm
  run migration:run`/`npm run seed` against this local Postgres for the
  first time (core's own `org.*`/`core.*` schemas had never been populated
  before this verification needed real employee/org-unit data) — the seed
  script itself failed partway through on a pre-existing, unrelated
  `policy_type` check-constraint mismatch (nothing to do with this
  module's own work), but completed far enough to leave real tenant/org-unit/
  employee rows in place.

## Explicit assumptions (spec was ambiguous or silent here)
1. **`'day'`/`'week'`/`'month'` mean each employee's own real local
   calendar day/week/month** (ADR-0099), resolved via their assigned org
   unit's configured timezone — not a tenant-wide setting (no such concept
   exists; `timezone` lives on `OrgUnit`/`WorkingTimeCalendar`, not
   `Tenant`), and not UTC uniformly (this phase's own first cut, superseded
   the same day).
2. **`'shift'` period_type is not computed at all in this phase** — no
   contract exists for this module to learn real shift boundaries (Module
   04 owns `ShiftAssignment`; Module 05 only exposes the coarse
   `on_shift`/`null` boolean). Building it requires a new Module 04 client,
   out of scope here.
3. **`OccupancyRecord`/`ShrinkageRecord` are still not populated at all** —
   ADR-0099 closed the employee→org-unit half of this gap, but the
   activity-category-taxonomy half (no signal anywhere upstream richer than
   `on_shift`/`null`) is untouched and remains fully blocking on its own.
4. **`adherentSeconds`/`totalScheduledSeconds` measure "observed
   activity-covered time," not "real scheduled-shift time."** A no-show
   (zero events during a real scheduled shift) is invisible to this
   computation — it contributes to neither the numerator nor the
   denominator, not scored as a maximal deviation. A future phase adding
   real Module 04 shift-boundary comparison would change what this number
   *means*, not just refine its precision.
5. **An employee whose timezone can't be resolved (either gRPC call
   unavailable, or genuinely absent data) falls back to UTC**, logged, not
   omitted from the rollup — a degraded-but-present result, not a missing
   one.

## Out of scope for this phase (do not build yet)
- `'shift'` period_type, `OccupancyRecord`, `ShrinkageRecord` — blocked on
  Module 04's shift-boundary data (all three) and Module 05's activity
  taxonomy (the latter two); closing either is new, separately-scoped
  cross-module work per ADR-0098/0099.
- Any request path reading `AdherenceScore` (GraphQL `adherenceScores`
  query, REST equivalent) — not built in this phase; these jobs only write.
- Real Module 04 shift-boundary comparison (would change what "adherent"
  means, not just add precision) — a future phase's decision, with its own
  migration note, not a silent refinement of this phase's semantics.
- Any RBAC/permission check on the two new gRPC clients' calls, or on core's
  new `GetEmployeeOrgUnits` RPC — matches this platform's existing posture
  for every other internal service-to-service gRPC contract (ADR-0021).
