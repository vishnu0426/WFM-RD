# Module 06 Phase 7 Design Doc — Attendance & Leave Management: Carryover/Expiry Rule Engine

**Status:** Approved for implementation
**Owner:** Attendance & Leave pod (Module 06), same as Phases 1–6.
**Scope:** `LeaveCarryoverJobService` (`src/leave/carryover/`) - a daily
`@Cron` job with two idempotent, cross-tenant SQL steps: rollover (cap a
closed period's leftover days into its successor period, per
`LeaveType.carryover_rules`) and expiry (claw back unused, expired
carryover from `accrued_days`). New `leave_balance.carryover_applied`
column (Phase 7 migration) as the rollover step's own completion marker.
**Does not build**: any accrual-rate/base-accrual computation (this module
has never had one - Phase 7 assumes successor `LeaveBalance` rows already
exist with whatever base accrual some other, unbuilt process gave them;
rollover only adds the *carryover* on top); a real proactive-notification
delivery of expiring carryover (no notification-sending pipeline exists
anywhere in this platform); an `AuditLog` entry for routine rollover/
expiry activity (see ADR-0080's consequences).

## Problem

Three things needed a real decision before writing any SQL:

1. **Which of this platform's two existing scheduled-job patterns actually
   fits?** Module 02's skill-decay job (ADR-0017) uses a ledger table with
   a resume cursor; intraday-service's `AdherenceRollupSchedulerService`
   uses a single idempotent cross-tenant SQL statement with a re-entrancy
   guard and no ledger at all. The right choice depends on whether the
   underlying operation has a natural completion marker. Decay doesn't (it
   recomputes every employee every day); carryover rollover does (a given
   period's carryover is either applied or it isn't) - so the lighter
   pattern is the correct one to follow here, not the heavier one, even
   though ADR-0017 is the more elaborate precedent.
2. **What happens when `LeaveBalance` rows for a new period don't exist
   yet?** This module has never had an accrual-rate engine - every
   `LeaveBalance` row seen through Phase 6 was either seeded directly or
   created by `requestLeave`'s own reservation logic, never by a
   period-rollover process generating a *new* period's base allocation.
   Building that is a distinct, larger feature (would need Module 02's
   `EmploymentPolicy` accrual-rate data) that §5.2's own wording doesn't
   ask for - it asks for carryover/expiry *rules*, not accrual
   calculation. This phase assumes the successor period's row already
   exists (with its base accrual already set by whatever process created
   it) and only adds the carryover on top - a real, flagged gap, not an
   accidental omission.
3. **What does "proactive notification" mean when nothing sends real
   notifications?** Grepped the entire platform: `NotificationPreference`
   (Module 01) is a preferences table with no send mechanism behind it
   anywhere, and this module's own Phase 4 already hit and documented the
   identical gap for approval reminders. Building a second fabricated
   "notification" on the same non-existent pipeline would be worse than
   not building it - it would look real without being real. Flagged as an
   explicit gap, consistent with Phase 4's own precedent.

## Decision

**Migration** (`1700000900000-LeaveBalanceCarryoverAppliedFlag`):
`leave_balance.carryover_applied boolean NOT NULL DEFAULT false`, plus a
partial index on `(tenant_id) WHERE carryover_applied = false` matching
the rollover query's own predicate exactly.

**Rollover** (`ROLLOVER_SQL`): a single `UPDATE ... FROM ... JOIN
LATERAL` across every tenant at once (via `migratorPoolProvider`, RLS's
`ENABLE`-not-`FORCE` posture bypassed only by the table owner, same
reasoning as intraday's own provider). For each successor row where
`carryover_applied = false` and a closed predecessor period exists
(`period_end < CURRENT_DATE`, contiguous `period_start`), computes
`GREATEST(LEAST(leftover, maxCarryoverDays), 0)` and folds it into
`accrued_days`/`carryover_days_in`, with `carryover_expiry_date` computed
from `carryoverExpiryMonths` if configured (`NULL` = never expires - falls
out naturally from the expiry query's own `IS NOT NULL` guard, no
special-casing needed). `LeaveType.carryover_rules` jsonb keys are read
directly in SQL, regex-guarded before casting so malformed data degrades
to "no carryover" rather than crashing the whole batch.

**Expiry** (`EXPIRY_SQL`): a `WITH ... UPDATE` clawing back
`LEAST(carryover_days_in, availableDays)` from any row whose
`carryover_expiry_date` has passed, clearing both columns to 0/null on
completion (which is also this step's own idempotency marker).

**Scheduling**: `@Cron('0 3 * * *')`, one fixed UTC time - not
per-tenant-local-midnight (no timezone lookup exists in this module to
build on, a real but proportionate gap given carryover/expiry are
date-boundary events, not latency-sensitive ones). Rollover runs before
expiry in the same tick; see the service's own doc comment and ADR-0080
for why a freshly-rolled-over-but-already-expired carryover (a genuine
possibility under a large processing backlog) is correctly clawed back
immediately, not a bug.

## Blast radius

- New files: `src/database/migrator-pool.provider.ts`,
  `src/leave/carryover/leave-carryover-job.service.ts`. One migration.
  `LeaveBalance` entity gains `carryoverApplied`. `app.module.ts` gains
  `ScheduleModule.forRoot()` (new `@nestjs/schedule` dependency, this
  service's first `@Cron` usage). `LeaveModule` gains
  `migratorPoolProvider`/`LeaveCarryoverJobService` as providers. Three
  pairs of new metrics (`leave_carryover_{rollover,expiry}_runs_total`,
  `..._balances_{rolled_over,expired}_total`, `..._days_{rolled_over,expired}_total`).
- No changes to any existing endpoint, DTO, or decision path -
  `requestLeave`/`submitBackdatedLeave`/`decideLeaveRequest` are
  unaffected. `carryover_applied` defaults to `false` for every existing
  row via the migration's own `DEFAULT false`.

## Rollback plan

Revert `LeaveModule`'s two new providers, delete
`src/leave/carryover/`, `src/database/migrator-pool.provider.ts`, revert
`app.module.ts`'s `ScheduleModule` import, revert the `carryoverApplied`
entity field, revert the migration (`down()` drops the index and column).
No existing data is mutated by rolling this back - the column and job are
purely additive; leftover `carryover_days_in`/`carryover_expiry_date`
values already written by a rollover run before rollback stay as they are
(they were already correct at the time they were written).

Verified against real Postgres, not just mocked unit tests: real
rollover across two leave types (one with `carryover_rules` configured,
one without), real partial-claw-back expiry (an employee who used more
than half their carryover before it expired), real malformed-jsonb
resilience (a `carryover_rules` value that fails the regex guard doesn't
crash the batch), and a real re-run confirming idempotency (0 rows
affected the second time). Two genuine bugs were caught this way - see
the production readiness checklist.

## Explicit assumptions (spec was ambiguous or silent here)

1. **This phase does not create new-period `LeaveBalance` rows or compute
   base accrual amounts.** It only adds carryover on top of a successor
   row that already exists. A future phase building real accrual-rate
   computation (likely needing Module 02's `EmploymentPolicy`) would be
   the one to actually generate new periods.
2. **A fixed UTC cron time, not per-tenant local midnight.** This module
   has no per-tenant timezone lookup anywhere; building one is
   disproportionate to a date-boundary (not latency-sensitive) job.
3. **A carryover that is already expired by the time a backlogged rollover
   applies it gets clawed back in the same tick, not granted an extended
   expiry.** See ADR-0080's own reasoning.
4. **No proactive notification of expiring carryover.** No real
   notification-delivery pipeline exists anywhere in this platform - same
   gap Phase 4 already documented for approval reminders.
5. **No `AuditLog` entry for rollover/expiry.** Reserved for
   actor-attributed decisions (ADR-0079's posture), not routine scheduled
   recomputation - no precedent anywhere in this platform audits every
   background-job tick.

## Out of scope for this phase (do not build yet)

- Accrual-rate computation / new-period `LeaveBalance` row generation -
  explicit assumption 1.
- Per-tenant timezone-aware scheduling - explicit assumption 2.
- Real carryover-expiry notifications - explicit assumption 4.
- Phase 8 (absence pattern detection, observability/hardening).
- GraphQL.
