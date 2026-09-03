# ADR-0081: Absence pattern detection as three targeted heuristics over already-recorded LeaveRequest data, gated by a per-row acknowledgement dedup, with a second gRPC client for real holiday data

## Context
§2.1 defines exactly three `AbsencePatternType` values (`recurring_day_of_week`,
`pre_post_holiday`, `frequency_threshold` - confirmed against the Phase 1
schema's own `pattern_type` CHECK constraint, which does not include a
`no_show` value). §2.2 rule 4 requires `acknowledged_by` to gate all
downstream action. Through Phase 7, the `absence_pattern` table existed
with nothing reading or writing it.

## Decision

**Detection is a scheduled job (`AbsencePatternDetectionJob`, `@Cron('0 4
* * *')`), not event-driven** - consistent with the "no_show detection
would need a proactive sweep, not an event handler" reasoning flagged
since Phase 1: a *pattern* is inherently a property of accumulated history,
not a single event, so every one of the three types is detected by
periodically re-scanning `LeaveRequest` history, the same posture
`LeaveCarryoverJobService` (Phase 7) established for period-boundary
recomputation.

**Two of three steps are pure, idempotent, cross-tenant SQL** via the same
`migratorPoolProvider` Phase 7 introduced - `frequency_threshold` (total
approved leave-days in a window, capped/scored via `LEAST(1.0, days /
(threshold * 2))`) and `recurring_day_of_week` (each approved request's
date range expanded via `generate_series`, grouped by
`EXTRACT(DOW FROM ...)`, scored by the dominant day's actual share of the
employee's total absence-days - a naturally bounded [0,1] proportion, not
an invented formula).

**`pre_post_holiday` needs a real holiday calendar**, which is not a
permanent gap the way Module 02's org-coverage check was (ADR-0076): core
already exposes a real, working `CalendarService.GetWorkingTimeRules`
gRPC RPC (`src/grpc/controllers/calendar-grpc.controller.ts`), serving
real per-tenant holiday data. This phase adds
`CalendarGrpcClientService`/`CalendarGrpcClientModule`
(`attendance-leave-service/src/grpc/`) - this service's *second* gRPC
client (Phase 6's `AuditGrpcClientService` was the first), same
`CORE_GRPC_URL`/`process.cwd()`-relative-proto-path posture, same
constants-file split to avoid the circular-import failure Phase 6's own
verification caught. Because holiday data is tenant-scoped and a single
cross-tenant SQL statement can't make a gRPC call mid-query, this step
loops over tenants with recent leave activity, one `GetWorkingTimeRules`
call each, then one parameterized per-tenant SQL statement using that
tenant's holiday-date array. A calendar-service failure for one tenant is
caught and logged per-tenant, not allowed to abort detection for every
other tenant in the same tick - the same resilience posture
`LeaveConflictCheckService` established for its own gRPC/REST dependency,
adapted for a batch context (fail one unit of work, not the whole job).

**Adjacency is per-`LeaveRequest`, not per-expanded-day**: `pre_post_holiday`
checks whether a request's `dateRangeStart - 1` or `dateRangeEnd + 1` is a
holiday - whether the leave *block* bridges a holiday (the actual
long-weekend-extending behavior §2.1 names), not whether any individual
day within a long request happens to sit near one (which
`recurring_day_of_week`'s day-expansion approach would have made easy to
copy, but would answer a different, wrong question here).

**Acknowledgement gating, concretely**: `acknowledgeAbsencePattern`
(`POST /v1/leave/absence-patterns/:id/acknowledge`) sets `acknowledged_by`
once (a second acknowledgement attempt is `409`, mirroring
`LeaveRequestAlreadyDecidedError`'s not-idempotent-by-design posture). The
one concrete enforcement point for §2.2 rule 4 this phase can point to:
every detection step's `INSERT` is gated by `WHERE NOT EXISTS (... AND
acknowledged_by IS NULL)` - at most one *unacknowledged* row per
`(tenant_id, employee_id, pattern_type)` at a time. Acknowledging a
pattern is what allows the *next* run to create a fresh row if the
behavior is still ongoing, rather than either silently suppressing
re-detection forever or accumulating duplicate unacknowledged noise. No
other automated action anywhere in this platform consumes `AbsencePattern`
rows today (confirmed: no notification-delivery pipeline exists anywhere,
the same gap Phase 4/7 already flagged) - the gate's job right now is
exactly this dedup behavior, not suppressing some other, unbuilt
downstream action.

**`GET /v1/leave/absence-patterns`** (unacknowledged only, `ORDER BY
detected_at DESC`) is this phase's own addition, not named in §3.2's REST
table - the same "a feature needs a way to see its own output to be a
real, testable surface" reasoning that gave `requestLeave`/
`decideLeaveRequest` REST paths ahead of GraphQL. It is a direct match for
`idx_absence_pattern_tenant_unacknowledged`, the partial index Phase 1
built specifically for "is there anything actionable" (that index's own
doc comment) - Phase 1 anticipated this query's shape years (in module-
timeline terms) before this phase wrote it.

## Two real bugs this phase's own verification caught

- The `recurring_day_of_week` step's `generate_series` needed no fix, but
  the `pre_post_holiday` step's calendar-lookup window did: an earlier
  version fetched holidays only through `toDate: today`, while the
  `leave_request` query it feeds has no upper bound on `date_range_start`
  (an approved future-dated request is legitimate request-timing signal,
  included the same way the other two steps include future dates). A test
  scenario with a leave request adjacent to a holiday that hadn't happened
  yet silently detected nothing - fixed by extending the calendar-lookup
  window symmetrically (`today ± windowDays`), not just backward.
- Confirmed (as a non-bug, but a `psql`-vs-real-runtime distinction worth
  recording): this service's own gRPC client wiring
  (`CalendarGrpcClientService`) was verified via `@nestjs/microservices`'
  `ClientProxyFactory.create(...)` directly against the real, running core
  process - not a mocked stub - the same category of verification ADR-0079
  used for the audit client.

## Consequences

- `attendance-leave-service` gains a second gRPC client dependency on core
  and a second `@Cron` job. `no_show` pattern detection remains
  permanently out of `AbsencePatternType`'s three values and unbuilt - not
  an oversight, confirmed against the schema's own CHECK constraint.
- Confidence-score formulas are explicit, documented heuristics this
  module invented (the spec gives a column and a CHECK constraint, not a
  formula) - `LEAST(1.0, count / (threshold * 2))` for the two
  threshold-based types, the day's actual share for
  `recurring_day_of_week`. A future phase revisiting detection quality
  should treat these as a documented starting point, not an accidental
  choice to work around.
- No `AuditLog` entry for detection or acknowledgement - same proportion
  argument as ADR-0080's carryover jobs (routine/UI-driven activity, not
  the compliance-weighted backdated-decision case ADR-0079 built for).
