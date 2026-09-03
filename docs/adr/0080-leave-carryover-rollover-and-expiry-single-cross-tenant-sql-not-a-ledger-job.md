# ADR-0080: Leave carryover rollover/expiry as idempotent cross-tenant SQL, keyed on a per-row completion marker - not Module 02's decay-job ledger pattern

## Context
§5.2 flags leave carryover/expiry as a risk to build now: unused days from
a closed accrual period should roll into the next period up to a
tenant/leave-type-configured cap (`LeaveType.carryover_rules.maxCarryoverDays`),
with an optional expiry (`carryoverExpiryMonths`) after which any *still
unused* portion of that carried-over amount is clawed back. Phase 1 already
shaped `LeaveBalance.carryover_days_in`/`carryover_expiry_date` for exactly
this, but nothing has read or written them through Phase 6.

The module prompt's own precedent for a scheduled background job in this
platform is Module 02's skill-decay job (ADR-0017): a ledger table
(`decay_job_runs`) keyed on `(tenant_id, run_date)`, a resume cursor, and
per-batch checkpointing. Before building carryover's own job, it was worth
checking whether that same ledger pattern actually fits here, or whether a
lighter mechanism - already used elsewhere in this same platform - is the
better match.

## Decision

**No ledger table.** Decay is a continuous recompute with no natural
terminal state - every employee gets reprocessed every run, so
`decay_job_runs` exists purely to answer "did today's run finish, and
where." Carryover rollover is different: it is a genuine one-time event
per `(employee, leave_type, period)` triple, and the schema already has a
natural place for a completion marker to live - the row itself. This phase
adds exactly one new column, `leave_balance.carryover_applied` (boolean,
default false, Phase 7 migration), and uses `WHERE carryover_applied =
false` as both the job's targeting predicate *and* its idempotency
guarantee. `carryover_days_in = 0` was not sufficient on its own: a
genuinely-zero carryover (no leftover, or no `carryover_rules` configured)
is a legitimate result that should never be reprocessed, but is
indistinguishable from "never evaluated" without a separate flag.

**A single cross-tenant SQL statement per step, not a per-tenant loop or a
JS-side cursor.** `LeaveCarryoverJobService` (`src/leave/carryover/`)
mirrors intraday-service's own `AdherenceRollupSchedulerService` far more
closely than Module 02's decay job: one `UPDATE ... FROM ... JOIN LATERAL`
for rollover, one `WITH ... UPDATE` for expiry, both run via a
`agno_migrator`-credentialed `Pool` (`migratorPoolProvider`, own copy of
intraday's, per ADR-0039's "each service owns its cross-tenant
infrastructure" precedent) because this service's RLS posture is `ENABLE`
not `FORCE` - only the table owner sees rows across every tenant in one
query, the exact same reasoning intraday's own provider doc comment gives.
A `ticking` boolean re-entrancy guard plus a single `@Cron('0 3 * * *')`
tick (this service's first `@Cron` usage of any kind - `ScheduleModule`
added to `app.module.ts`) is the whole scheduling mechanism; no fixed
tenant-local-midnight computation (unlike the decay job) since this module
has no existing per-tenant-timezone lookup, and building one is
disproportionate to this phase's actual ask.

**Rollover math**: for each `LeaveBalance` "successor" row not yet
processed, its immediate predecessor (same employee/leave type, `successor.period_start
= predecessor.period_end + 1`, `predecessor.period_end < CURRENT_DATE`) is
joined via `LATERAL`, and the capped amount is
`GREATEST(LEAST(predecessor.accrued_days - predecessor.used_days -
predecessor.pending_days, maxCarryoverDays), 0)`. `maxCarryoverDays`/
`carryoverExpiryMonths` are read directly from `LeaveType.carryover_rules`
jsonb in SQL (`->>'key'`), regex-guarded (`~ '^[0-9]+(\.[0-9]+)?$'`) before
casting to numeric/int - a malformed or missing value is treated as "no
carryover configured" (0 / never-expires) rather than throwing and failing
the entire cross-tenant batch for every other tenant's rows.

**Expiry math**: any row with `carryover_days_in > 0` and a real
`carryover_expiry_date` in the past has `LEAST(carryover_days_in,
GREATEST(accrued_days - used_days - pending_days, 0))` clawed back from
`accrued_days` - never more than what is actually still unused (an
employee who already consumed more than their carryover specifically has
nothing left of it to lose). `carryover_days_in > 0` doubles as this
step's own idempotency marker; both `carryover_days_in` and
`carryover_expiry_date` are cleared to 0/null on completion.

## A real bug this phase's own verification caught

Postgres does not allow a `LATERAL` item in an `UPDATE`'s `FROM`/`JOIN`
list to reference the `UPDATE` target table's own alias - only `WHERE`/
`SET` can see it. The rollover `LATERAL` subquery originally computed
`carryover_expiry_date` from `successor.period_start` (the target alias),
which failed at real-Postgres execution with `invalid reference to
FROM-clause entry for table "successor"` despite compiling and passing
every mocked unit test. Fixed by computing the identical value from
`predecessor.period_end + 1` instead (the `WHERE` clause already
constrains these two to be equal) - no unit test exercises real Postgres
SQL parsing, so this was only found by actually running the query.

A second, more interesting finding from the same verification pass: in a
test scenario simulating a large rollover backlog (a period whose
carryover-eligible successor had already existed for months before the
job ran), the freshly-computed `carryover_expiry_date` was itself already
in the past by the time rollover applied it - and the expiry step,
running immediately after in the same tick, correctly clawed it straight
back. This is judged correct, not a bug: the rule is "carryover expires N
months after the period starts," and an operational delay in *applying*
that rule does not entitle the balance to an expiry date nobody
configured. Documented as an explicit assumption rather than patched
around, since "extend the expiry to compensate for how late we were"
would be inventing business logic the spec never asked for.

## Consequences

- `attendance-leave-service` gains its first `@Cron` job and its second
  migrator-pool-credentialed cross-tenant query path (the first being this
  same phase's own rollover/expiry pair - Phases 1-6 had none).
- No proactive notification of expiring carryover is built. §5.2/the
  module's own broader notes ask for this, but no real notification
  *delivery* pipeline exists anywhere in this platform - Module 01's
  `NotificationPreference` is a preferences table, not a send mechanism,
  and this module's own Phase 4 already flagged the identical gap for
  approval reminders (`LeaveApprovalReminderWorker`'s doc comment).
  Building a fabricated "notification" on top of a non-existent delivery
  channel would misrepresent what actually happens; this is a documented
  gap, not a silently narrowed scope.
- No `AuditLog` entry is recorded for routine rollover/expiry activity,
  unlike Phase 6's backdated-decision audit calls. This is a deliberate,
  proportionate distinction: Module 01's `AuditLog` is for actions with
  human/system actor attribution and compliance weight (ADR-0079's own
  reasoning), not routine scheduled balance recomputation - the platform
  has no precedent of audit-logging every tick of a background job
  (the skill-decay job doesn't either).
