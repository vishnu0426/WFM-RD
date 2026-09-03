# Module 06 Phase 7 Production Readiness Checklist

Same honesty bar as Phases 1–6. This phase introduces this service's first
scheduled (`@Cron`) job and its first cross-tenant, migrator-credentialed
query path - verified by actually running the compiled job against real
Postgres with hand-built multi-period fixtures, not by trusting the SQL
compiles.

## Delivered in this phase (application code)

- [x] `leave_balance.carryover_applied` migration (additive column +
      partial index), `LeaveBalance.carryoverApplied` entity field.
- [x] `LeaveCarryoverJobService`: `@Cron('0 3 * * *')` tick running
      rollover then expiry, re-entrancy-guarded, using
      `migratorPoolProvider` (own copy of intraday-service's).
- [x] Rollover: caps a closed period's leftover
      (`accrued - used - pending`) at `LeaveType.carryover_rules.maxCarryoverDays`,
      folds it into the successor period's `accrued_days`, computes
      `carryover_expiry_date` from `carryoverExpiryMonths` if configured.
      Regex-guarded jsonb reads so malformed `carryover_rules` degrade to
      "no carryover" instead of crashing the batch.
- [x] Expiry: claws back `LEAST(carryover_days_in, availableDays)` from
      any row whose carryover has expired, never pushing balances
      negative.
- [x] Six new metrics (`leave_carryover_{rollover,expiry}_runs_total{result}`,
      `..._balances_{rolled_over,expired}_total`,
      `..._days_{rolled_over,expired}_total`).
- [x] `@nestjs/schedule` added, `ScheduleModule.forRoot()` wired into
      `app.module.ts` - this service's first `@Cron` usage of any kind.
- [x] Unit tests: 6 new tests in `leave-carryover-job.service.spec.ts`
      (tick ordering, metric recording on success for both steps, error
      handling for both steps without one blocking the other, re-entrancy
      guard), 3 new tests in the migration spec. Node-side total: 108
      tests across 19 suites, all passing. `typecheck`/`lint`/`build` all
      clean.

## Verified against real infrastructure

- [x] Real local Postgres with all prior migrations plus this phase's own
      applied. The job was run via the actual compiled
      `LeaveCarryoverJobService` class (not hand-transcribed SQL in
      `psql`) against a real `pg.Pool` - deliberately, since a JS
      template-literal string (`\\.` in source -> `\.` at runtime) and raw
      SQL text extracted by another tool are not the same string, and
      testing the wrong one would have missed the real bug below.
- [x] Rollover scenario, leave type *with* `carryover_rules` configured
      (`{maxCarryoverDays: 5, carryoverExpiryMonths: 6}`): predecessor
      leftover of 8 days correctly capped at 5; successor's `accrued_days`
      correctly incremented; `carryover_expiry_date` correctly computed
      from the successor's own period start.
- [x] Rollover scenario, leave type with *no* `carryover_rules`
      configured (`{}`): correctly resolves to 0 carryover, still marks
      `carryover_applied = true` (never re-evaluated needlessly).
- [x] Rollover scenario, malformed `carryover_rules`
      (`{"maxCarryoverDays": "not-a-number"}`): correctly treated as 0,
      no crash, no impact on other tenants'/employees' rows in the same
      batch.
- [x] Idempotency: re-ran the full tick a second time with no new
      eligible rows - both steps correctly affected 0 rows.
- [x] Expiry scenario, full claw-back and partial claw-back (an employee
      who used 17 of 20 accrued days, of which 5 came from an expiring
      carryover - correctly clawed back only the 3 still-unused days, not
      the full 5, and never pushed the balance negative).
- [x] Confirmed the new Prometheus counters increment correctly against
      every scenario above.

## Two genuine bugs this verification caught (not hypothetical)

- **Postgres does not allow a `LATERAL` item in an `UPDATE`'s `FROM`/
  `JOIN` list to reference the `UPDATE` target's own alias.** The
  rollover query originally computed `carryover_expiry_date` from
  `successor.period_start` (the target alias) and failed at real
  execution with `invalid reference to FROM-clause entry for table
  "successor"` - despite compiling cleanly and passing every mocked unit
  test (which never sends real SQL to a real planner). Fixed by computing
  the identical value from `predecessor.period_end + 1` instead, which
  the `WHERE` clause already constrains to be equal.
- **A rollover-then-immediate-expiry interaction under a processing
  backlog.** A test scenario using a period whose successor had existed
  for months before the job first ran produced a freshly-computed
  `carryover_expiry_date` that was *already in the past* - and the expiry
  step, running in the same tick, immediately clawed it back. Judged
  correct on inspection (an operational delay in applying a rule doesn't
  entitle an extended expiry nobody configured), but the service's own
  doc comment originally asserted this "could never happen" - that claim
  was false and has been corrected in place (ADR-0080).

## Explicitly NOT done here (needs a later phase, or is out of scope)

- [ ] **New-period `LeaveBalance` row generation / accrual-rate
      computation.** This phase only adds carryover on top of an
      already-existing successor row. See the design doc's explicit
      assumption 1.
- [ ] **Per-tenant timezone-aware scheduling.** Fixed UTC cron time - see
      explicit assumption 2.
- [ ] **Real proactive notification of expiring carryover.** No
      notification-delivery pipeline exists anywhere in this platform -
      same gap Phase 4 already flagged for approval reminders.
- [ ] **`AuditLog` entries for rollover/expiry activity.** Reserved for
      actor-attributed decisions, not routine background-job ticks.
- [ ] **Phase 8** (absence pattern detection, observability/hardening).
- [ ] **GraphQL.**
- [ ] A separate worker process, Terraform provisioning, Vault credential
      issuance, SAST / dependency scanning / SBOM - same explicit
      non-goals already stated platform-wide for every phase.
