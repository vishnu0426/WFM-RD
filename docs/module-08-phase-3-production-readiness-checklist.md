# Module 08 Phase 3 Production Readiness Checklist

## Delivered in this phase (application code)

- [x] `AdherenceDailyRollupJobService` — 15-minute `@Cron`, computes
      `period_type = 'day'` `AdherenceScore` rows from Module 05's raw
      `intraday.adherence_event` table via `MIGRATOR_PG_POOL`, idempotent
      `ON CONFLICT ... DO UPDATE` upsert, trailing re-aggregation window to
      catch late-arriving events - bucketed by each employee's own real
      IANA timezone (`AT TIME ZONE`, ADR-0099), not UTC uniformly.
- [x] `AdherenceWeeklyMonthlyRollupJobService` — once-daily `@Cron`,
      aggregates already-computed `'day'` rows into `'week'`/`'month'`
      rows, never re-queries `adherence_event`, same per-employee-timezone
      bucketing. Trailing-window boundary correctly rounded to a
      full-week/full-month floor plus a one-day margin for extreme
      timezone offsets (a real bug caught and fixed before this ever ran
      against real data — see the design doc) — dedicated unit tests
      assert the exact rounding across three different month-start
      weekdays.
- [x] **Real per-employee timezone support (ADR-0099), closing the
      "support all country timezones" gap this phase's first cut
      (ADR-0098) explicitly disclosed as unresolved:**
      `EmployeeService.GetEmployeeOrgUnits` (new RPC, core's root `src/`,
      backed by a new `EmployeesRepository.findByIds`),
      `EmployeeGrpcClientModule`/`CalendarGrpcClientModule` (this service's
      first gRPC clients of any kind), and `TimezoneResolverService`
      (resolves + caches + falls back to UTC per employee, logged, never
      silently). Both rollup queries rewritten around Postgres's own
      `AT TIME ZONE` operator (DST-correct, no hand-rolled offset math).
- [x] ADR-0098: revises Phase 1's ADR-0094 rollup-source decision (raw
      `adherence_event` via `agno_migrator`, not the mutable hourly/daily
      rollup tables via a never-actually-needed dedicated connection),
      documents the exact adherence-calculation semantics this phase
      implements, and (at the time) named two confirmed capability gaps
      blocking `OccupancyRecord`/`ShrinkageRecord`/`'shift'` period_type -
      one of which (employee→org-unit lookup) ADR-0099 closed the same day;
      ADR-0098 itself carries forward-reference notes rather than being
      rewritten.
- [x] ADR-0099: the employee→org-unit RPC addition and the real
      per-timezone rollup redesign, including the exact bug found and fixed
      during E2E verification (see below).
- [x] `test/integration/adherence-rollup-reproducibility.spec.ts` — §0.5's
      own defining correctness property, verified for real: the same day,
      rolled up twice against real, immutable Postgres data, produces
      byte-identical numbers (same row `id`, same `adherentSeconds`/
      `totalScheduledSeconds`/`adherencePct`/`majorDeviationCount`), while
      `computedAt` strictly advances, proving the second run genuinely
      recomputed rather than skipped. This service's first
      `test/integration/` directory (deferred out of Phase 1 for the same
      reason attendance-leave's own Phase 1 deferred it).
- [x] 14 new unit tests across this phase (daily job's trailing-window/
      threshold/re-entrancy/timezone-grouping behavior, weekly/monthly
      job's boundary rounding and timezone grouping, `TimezoneResolverService`'s
      deduplication/caching/fallback behavior) — 52 unit tests total in
      this service, all passing without a live Postgres.
- [x] Verified against real Postgres end to end, including infrastructure
      this phase newly depends on: ran `intraday-service`'s own `npm run
      migration:run` for the first time in this local environment
      (`intraday.adherence_event` didn't exist before this phase's own
      verification needed it), booted this service's full app via
      `NestFactory.createApplicationContext` and fired both cron jobs
      through the actual DI-wired providers (not just the hand-constructed
      instances the automated tests use), confirmed real rows land in
      `compliance.adherence_score` for all three `period_type`s, and
      confirmed `/metrics`'/`/healthz`/`/readyz` are unaffected.
- [x] **Full cross-service E2E verification for ADR-0099**: ran root's own
      `npm run migration:run` (core's `org.*`/`core.*` schemas had never
      been populated before), seeded two org units in `Asia/Kolkata` and
      `Europe/London` with real `WorkingTimeCalendar` rows and two
      employees assigned to them, booted core's actual gRPC server (root
      `src/main.ts`), and ran both rollup jobs against it for real. Result:
      each employee's `period_start`/`period_end` land exactly on their own
      real local midnight/week-start/month-start, verified by converting
      the stored `timestamptz` back through that employee's own assigned
      timezone (`period_start AT TIME ZONE <their timezone>` = exactly
      `00:00:00` in every case) - not just "a plausible-looking value," an
      arithmetically confirmed one, independently for two different
      countries in the same run.
- [x] **A real bug found and fixed during that E2E verification, invisible
      to every unit test and to the isolated SQL/pg.Pool reproductions that
      preceded it**: `CalendarService.GetWorkingTimeRules` returned
      `timezone: 'UTC'` for both freshly-created org units - successfully,
      with no thrown error - because no `WorkingTimeCalendar` row existed
      for either one yet (only a tenant-wide default did), and core's own
      schema defaults that column to `'UTC'` when nothing more specific is
      configured. `TimezoneResolverService`'s fallback-and-log path never
      fired, because the call didn't fail - it succeeded with a default
      value indistinguishable, from this module's side, from a correctly
      resolved `'UTC'` org unit. Root-caused by tracing the actual gRPC
      responses directly (not by re-reading code), fixed by seeding real
      per-org-unit calendar rows - a genuine test-fixture gap, not a defect
      in this module's own code, but the closest a real end-to-end run got
      to a false-negative in this phase's entire verification effort.
- [x] A second real finding, disclosed rather than silently worked around
      (superseded by ADR-0099's real per-timezone design, kept here for the
      historical record): Postgres `date_trunc()` truncates in the
      connecting session's timezone (`Asia/Kolkata` on this local
      instance), not UTC - confirmed by a hand-seeded row using
      `date_trunc('day', now())` producing a different result than
      ADR-0098's own first-cut UTC-computed boundaries.

## Explicitly NOT done here (needs a later phase)

- [ ] **`period_type = 'shift'`.** No contract exists for this module to
      learn real shift boundaries from Module 04. Building one is new,
      separately-scoped cross-module work (ADR-0098).
- [ ] **`OccupancyRecord`/`ShrinkageRecord` — populated by nothing.** One of
      the two confirmed capability gaps closed this phase (employee→org-unit
      lookup, ADR-0099); the other (no activity-category taxonomy anywhere
      upstream) is untouched and still fully blocking on its own.
      `occupancyTrend`/`shrinkageBreakdown` (whichever phase builds them)
      will return empty results honestly until it closes — not wrong ones.
- [ ] **No request path reads `AdherenceScore` yet.** These two jobs only
      write. A GraphQL `adherenceScores` query / REST equivalent is not
      built in this phase.
- [ ] **No real Module 04 shift-boundary comparison.** `adherentSeconds`/
      `totalScheduledSeconds` measure observed-activity-covered time, not
      real scheduled-shift time — a no-show is invisible to this
      computation, not scored as maximally non-adherent. This is a
      disclosed, real limitation of what Module 05's current event stream
      can support, not an oversight.
- [ ] **`ADHERENCE_MAJOR_DEVIATION_THRESHOLD_SECONDS`'s default (300s) is a
      placeholder**, same posture as every other flat-env-config threshold
      in this platform's early phases (e.g. attendance-leave's
      `ATTENDANCE_LATE_GRACE_MINUTES`) — not a considered production
      policy value.
- [ ] **No alerting wired to `compliance_rollup_job_lag_seconds`/
      `compliance_rollup_job_runs_total`.** Both metrics are real and
      populated by this phase's own cron ticks (declared in Phase 1,
      genuinely recorded into starting now) - nothing pages on them yet.
- [ ] **No RBAC/permission check on either new gRPC client call or on
      core's new `GetEmployeeOrgUnits` RPC.** Matches this platform's
      existing posture for every other internal service-to-service gRPC
      contract (ADR-0021) - not a gap specific to this phase.
- [ ] **`TimezoneResolverService`'s org-unit-timezone cache is in-process,
      unbounded by size, and lost on restart.** Fine at this phase's scale
      (one cache entry per distinct org unit actually seen); a platform
      with many thousands of org units across many tenants would want an
      eviction policy this phase doesn't build.
