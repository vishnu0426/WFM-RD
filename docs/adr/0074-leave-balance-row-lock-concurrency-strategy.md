# ADR-0074: `LeaveBalance` double-booking prevention uses `SELECT ... FOR UPDATE` on the composite PK, not an `EXCLUDE` constraint or `SERIALIZABLE` transaction

## Context
§2.2 rule 1 is this module's own explicit "specific double-booking bug
class" call-out: a new `LeaveRequest` submission must check against
`availableDays` (`accruedDays - usedDays - pendingDays`) with a
transactional check - "a row lock or serializable transaction on the
`LeaveBalance` row during submission, not just an application-level
read-then-write that races under concurrent requests." §6 additionally asks
for a dedicated concurrency test simulating overlapping concurrent leave
requests against the same balance.

This is a schema-shaping decision, not just an application-code one, so it
belongs in Phase 1 even though the enforcement code itself (the
`requestLeave` mutation) is Phase 3 scope - the same reasoning Module 05's
Phase 1 used to pin ADR-0062/0063 before their consuming code existed.
Two precedents exist elsewhere in this platform for "prevent two
concurrent operations from landing on the same row incorrectly," neither a
direct fit:
- `scheduling-service`'s job-queue claim
  (`test_concurrent_claims_never_double_claim_the_same_job`) uses
  `SELECT ... FOR UPDATE SKIP LOCKED` - built for *distributing* one row to
  exactly one of several racing claimers (skip what's already locked, grab
  something else). That's not this problem: two overlapping `LeaveRequest`
  submissions against the *same* `LeaveBalance` row must not both proceed,
  not get routed to different rows.
- No `EXCLUDE` constraint or `SERIALIZABLE` isolation usage exists anywhere
  in this repo (confirmed by the research survey preceding this ADR) - both
  would be establishing a new pattern with zero prior art, not extending
  one.

## Decision
`LeaveBalance`'s composite PK - `(employee_id, leave_type_id, period_start,
period_end)`, exactly as §2.1 specifies - is also the row-lock granularity:
Phase 3's `requestLeave` mutation opens a transaction, runs
`SELECT ... FOR UPDATE` against the exact PK row for the request's
employee/leave-type/period, computes `availableDays` from the locked read,
and either inserts the `LeaveRequest` + increments `pending_days` in the
same transaction or aborts before either write - never a separate read then
a separate write. A second concurrent submission against the same PK row
blocks on the lock (not `SKIP LOCKED` - it must wait and re-evaluate
`availableDays` against the first transaction's committed result, not skip
to a different row or proceed blind), which is exactly the semantics
`FOR UPDATE` gives for free without raising `SERIALIZABLE`'s
transaction-retry burden on every caller.

An `EXCLUDE USING gist` constraint was considered and rejected for this
specific rule: it fits a date-*range-overlap* invariant ("no two leave
requests for the same employee may cover overlapping dates"), which is a
different, complementary correctness property §2.2 rule 1 does not actually
ask for (the module prompt's own bug-class description is about
`pending_days` accounting, not date-range overlap) - conflating the two
would over-scope this decision beyond what Phase 3 needs to build. If a
future phase decides overlapping-date-range prevention is also required,
that is a separate ADR, not a retrofit of this one.

## Consequences
- No DDL beyond the composite PK already specified in §2.1 is needed to
  support this - Phase 3's enforcement code is the only thing this decision
  adds work to, not this migration.
- §6's dedicated concurrency test (two `asyncio`/`Promise.all`-concurrent
  submissions against the same `LeaveBalance` row, asserting exactly one
  succeeds when only one has room) exercises this lock directly, and is the
  same shape as `test_concurrent_claims_never_double_claim_the_same_job`
  even though the underlying SQL idiom differs (`FOR UPDATE`, not
  `FOR UPDATE SKIP LOCKED`) - lands in Phase 3 alongside the mutation it's
  testing.
- A submission that finds insufficient `availableDays` under the lock must
  still release the lock promptly (transaction commit/rollback, not holding
  it open pending some external check) - the synchronous gRPC/REST
  conflict-check calls into Module 04/02 (§4.4, Phase 3) must happen
  *before* opening this transaction, not inside it, or a slow upstream
  service would hold a row lock open and serialize unrelated leave
  submissions against the same balance row for no reason. This ordering
  constraint is binding on Phase 3's implementation, not just a suggestion.
