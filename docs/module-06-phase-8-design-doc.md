# Module 06 Phase 8 Design Doc — Attendance & Leave Management: Absence Pattern Detection + Observability/Hardening

**Status:** Approved for implementation. **This is the final phase of
Module 06's 8-phase build (§7).**
**Owner:** Attendance & Leave pod (Module 06), same as Phases 1–7.
**Scope:** `AbsencePatternDetectionJob` (`@Cron`, three heuristics matching
§2.1's exact `AbsencePatternType` values), `acknowledgeAbsencePattern`
(`POST /v1/leave/absence-patterns/:id/acknowledge`), a supporting `GET
/v1/leave/absence-patterns` list endpoint, this service's second gRPC
client (`CalendarGrpcClientService`, core's `CalendarService`), and the
observability/hardening half of this phase: `docs/module-06-runbook.md`
(spanning all 8 phases) and `observability/grafana-dashboard-module-06.json`.
**Does not build**: `no_show` pattern detection (not one of §2.1's three
`AbsencePatternType` values - confirmed against Phase 1's own schema CHECK
constraint); GraphQL (never triggered by any phase); real notification
delivery of detected patterns (no such pipeline exists anywhere in this
platform - the same gap Phase 4/7 already documented).

## Problem

1. **What exactly should "detection" compute, given the spec names types
   but not formulas?** §2.1 fixes three `pattern_type` values and a
   `confidence_score` column with a `[0,1]` CHECK constraint, and nothing
   else about how to compute either the trigger condition or the score.
   This phase makes and documents three explicit, defensible heuristics
   (ADR-0081) rather than leaving the column meaningless or inventing
   something unfalsifiable - each formula is simple, monotonic, bounded,
   and stated as an assumption open to revision.
2. **Does `pre_post_holiday` have a real data source, or is it another
   permanent gap like Module 02's org-coverage check?** Checked core's
   actual gRPC surface: `CalendarService.GetWorkingTimeRules` already
   exists, already works, already serves real per-tenant holiday data
   (confirmed against the demo seed's own working-time calendar). This is
   a real capability to build against, not a stub.
3. **What does `acknowledged_by` "gate" concretely, when no downstream
   consumer of `AbsencePattern` exists anywhere?** The honest answer:
   right now, it gates *re-detection* - `WHERE NOT EXISTS (... AND
   acknowledged_by IS NULL)` in every detection step's own `INSERT` is the
   one concrete enforcement point this phase can build, and it is a real
   one (verified: acknowledging a pattern and re-running detection with
   the underlying behavior still ongoing correctly creates a fresh row).
   A future notification/analytics consumer would be a *second*
   enforcement point, not a replacement for this one.

## Decision

**`AbsencePatternDetectionJob`** (`src/leave/absence-pattern/`):
`@Cron('0 4 * * *')` (after `LeaveCarryoverJobService`'s 3am slot),
re-entrancy-guarded, three independently-metriced steps:

- `frequency_threshold`: cross-tenant `INSERT ... SELECT` via the
  migrator pool, summing approved `LeaveRequest` days per employee within
  `ABSENCE_PATTERN_FREQUENCY_WINDOW_DAYS` (default 90), flagged at
  `ABSENCE_PATTERN_FREQUENCY_THRESHOLD_DAYS` (default 10),
  `confidence = LEAST(1.0, days / (threshold * 2))`.
- `recurring_day_of_week`: expands each approved request's date range via
  `generate_series`, groups by day-of-week within
  `ABSENCE_PATTERN_RECURRING_WINDOW_DAYS` (default 180), flags when total
  sample size clears `ABSENCE_PATTERN_RECURRING_MIN_SAMPLE_DAYS` (default
  5) and the dominant day's share clears
  `ABSENCE_PATTERN_RECURRING_SHARE_THRESHOLD` (default 0.4),
  `confidence = ` that share directly.
- `pre_post_holiday`: per-tenant loop (tenants discovered via a
  cross-tenant `SELECT DISTINCT`), one `CalendarGrpcClientService.getWorkingTimeRules`
  call per tenant (window symmetric around today by
  `ABSENCE_PATTERN_HOLIDAY_WINDOW_DAYS`, default 180 each direction - see
  the production readiness checklist for why symmetry matters, a real bug
  this phase caught), then one parameterized SQL statement checking
  whether `dateRangeStart - 1` or `dateRangeEnd + 1` is in that tenant's
  holiday list, flagged at `ABSENCE_PATTERN_HOLIDAY_THRESHOLD_COUNT`
  (default 2), same `LEAST(1.0, count / (threshold * 2))` scoring as
  `frequency_threshold`.

All three dedup via `WHERE NOT EXISTS (SELECT 1 FROM absence_pattern ap
WHERE ... AND ap.pattern_type = '...' AND ap.acknowledged_by IS NULL)` -
at most one unacknowledged row per `(tenant, employee, pattern_type)`.

**`CalendarGrpcClientService`/`CalendarGrpcClientModule`**
(`src/grpc/`): this service's second gRPC client, mirroring
`AuditGrpcClientService`'s shape exactly (own constants file from the
start, learning from Phase 6's own circular-import bug).

**`AcknowledgeAbsencePatternService`**: row-locked read, `409` via
`AbsencePatternAlreadyAcknowledgedError` if already acknowledged, `404`
via `AbsencePatternNotFoundError` if not found, else `UPDATE
acknowledged_by`. **`ListAbsencePatternsService`**: unacknowledged-only,
`ORDER BY detected_at DESC`, matching Phase 1's own pre-built partial
index.

## Blast radius

- New files: `src/grpc/calendar-grpc-client.{module,service,constants}.ts`,
  `src/leave/absence-pattern/*` (job, controller, two services, DTO), two
  new error classes, `docs/module-06-runbook.md`,
  `observability/grafana-dashboard-module-06.json`. Seven new env vars
  (all with defaults - no `.env.example` entry is load-bearing). Four new
  metrics. `LeaveModule` gains `CalendarGrpcClientModule` import and four
  new providers/one new controller. `domain-error.filter.ts` gains two
  mappings.
- No migration - `absence_pattern`'s schema (including its own
  acknowledgement-state partial index) has been correct and unused since
  Phase 1.
- No changes to any other module's service code.

## Rollback plan

Revert `LeaveModule`'s new imports/providers/controller, delete
`src/grpc/calendar-grpc-client.*`, `src/leave/absence-pattern/`, revert
the two new `domain-error.filter.ts` mappings. No data migration to
revert - rolling this back leaves any already-detected `AbsencePattern`
rows in place (harmless, inert data per §2.2 rule 4's own framing) and
simply stops new ones from being created or acknowledged.

Verified against real infrastructure - real Postgres seeded with the
platform's own demo tenant/working-time-calendar (real holidays:
2026-01-01, 2026-07-04, 2026-12-25), a real built core service serving
real `CalendarService.GetWorkingTimeRules` responses (verified via
`@nestjs/microservices`' `ClientProxyFactory` directly, not a mocked
stub), and hand-built `LeaveRequest` fixtures for all three pattern types
plus the acknowledge/re-detect gate. Two real bugs were caught and fixed -
see the production readiness checklist.

## Explicit assumptions (spec was ambiguous or silent here)

1. **`no_show` pattern detection is out of scope, permanently, for this
   phase and this `AbsencePatternType` design** - confirmed against the
   schema's own CHECK constraint, not an oversight. It would need a
   proactive scheduled-shift-vs-no-clock-in sweep this module has never
   built (flagged since Phase 1/5).
2. **Confidence-score formulas are this phase's own explicit heuristic**,
   not a specified statistical model - see ADR-0081.
3. **Detection considers approved requests regardless of whether their
   dates are past or future** - an approved request already reflects real
   request-timing behavior at the moment it was decided, not only once its
   dates arrive. This is why `pre_post_holiday`'s calendar-lookup window
   must extend into the future by the same amount it looks backward (a
   real bug caught and fixed, not a design debate resolved on paper).
4. **`acknowledged_by` currently gates only re-detection** - there is no
   other automated consumer of `AbsencePattern` anywhere in this platform
   to gate. A future notification/analytics phase would add a second,
   independent enforcement point, not replace this one.
5. **No `AuditLog` entry for detection/acknowledgement** - routine/UI-
   driven activity, not the compliance-weighted case ADR-0079 built
   `AuditService` integration for.

## Out of scope for this phase (do not build yet)

- `no_show` pattern detection - explicit assumption 1.
- GraphQL - never triggered by any of the 8 phases.
- Real notification delivery of detected patterns - no delivery pipeline
  exists anywhere in this platform (Phase 4/7's own flagged gap, restated
  here for completeness since this is the phase that would have consumed
  one).
- Any accrual-rate/new-period-generation engine (Phase 7's own gap,
  unaffected by this phase).
