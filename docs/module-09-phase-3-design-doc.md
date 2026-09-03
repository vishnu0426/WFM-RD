# Module 09 Phase 3 Design Doc — Analytics & Reporting: Cross-Module Materialized Views

**Status:** Approved for implementation
**Owner:** Analytics & Reporting pod (Module 09), Principal Data Architect role continuing for this phase's own capability-gap finding (ADR-0109).
**Scope:** §8's own Phase 3 line: "Cross-module materialized views... `mv_cost_vs_budget`, `mv_attrition_by_site` - the genuinely multi-source aggregates." Concretely: two more `@Cron` refresh jobs, reusing Phase 2's `agno_migrator` pool pair unchanged - `MvCostVsBudgetRefreshJobService` (joining `org.employees.cost_center` × `scheduling.shift_assignments` × `attendance_leave.leave_request`, three schemas in one query) and `MvAttritionBySiteRefreshJobService` (`org.employees.termination_date` × an `org.org_units` ltree ancestor join).

## Problem

Designing the actual join for `mv_cost_vs_budget` surfaced a finding this phase's own design work had to settle before writing a single line of SQL: **§2.2's name for this view promises a dollar comparison ("cost vs budget") that no data anywhere in this platform can support.**

- `org.employees` has `cost_center` (a label) and `contract_hours_per_week`, but no `pay_rate`/`hourly_rate`/`salary` column - checked directly against the real table, not assumed.
- A repo-wide search for anything resembling `hourly_rate`, `pay_rate`, `salary`, `wage`, or `budget` across every service's migrations returns nothing.
- Module 09's own §2.1 entity list (`SavedReport`/`MetricDefinition`/`DashboardWidget` + this module's materialized-view schema) has no `Budget` concept either - this module doesn't own one, and per §0's own non-negotiable it must not invent one.

This is the same class of finding ADR-0098 named for Module 08's
`OccupancyRecord`/`ShrinkageRecord`: a source-spec view whose name promises
more than the actually-available upstream data supports. See ADR-0109 for
the full reasoning and the decision (ship `mv_cost_vs_budget` as an
hours/days labor-utilization proxy, name the dollar-figure gap precisely,
never fabricate a placeholder rate or budget).

A second, smaller finding for `mv_attrition_by_site`: attributing an
employee to "their site" requires walking `org.org_units`' hierarchy (an
employee's own `org_unit_id` can be a `team`/`department`, with `site`
somewhere above it), not a direct column lookup. Solved with `org_units.path`
(an `ltree` column already populated by existing triggers) and the `<@`
("descendant of or equal to") operator - verified against real hierarchy
data (`business_unit` → `department` → `site`) before writing the refresh
job, not assumed from the schema alone.

A third finding, smaller still: a real attrition *rate* (terminations ÷
headcount) needs a historical point-in-time headcount, which this
platform has no reconstructible source for without joining
`org.employee_history` (out of scope for this phase - named, not built).
`mv_attrition_by_site` therefore reports `terminations_count` only.

## Decision

**`mv_cost_vs_budget`** (ADR-0109): per `(tenant_id, cost_center, period_start)`
month bucket - `scheduled_hours`/`overtime_hours` (summed shift durations
from `scheduling.shift_assignments`, split on `is_overtime`) and
`approved_leave_days` (calendar days from `attendance_leave.leave_request`
where `status = 'approved'`, attributed to the request's start month).
Computed via two independent CTEs combined with a `FULL OUTER JOIN` so a
month with leave but no shifts (or vice versa) still produces one correct
row. Employees with `cost_center IS NULL` are excluded on both sides, not
attributed to a fabricated bucket.

**`mv_attrition_by_site`**: per `(tenant_id, site_org_unit_id, period_start)`
month bucket (bucketed on `termination_date`) - `terminations_count` only,
via `org.employees` joined to `org.org_units` twice (once for the
employee's own org unit, once for the nearest ancestor where
`type = 'site'`, matched with `eu.path <@ site.path`).

Both jobs reuse Phase 2's `RefreshModule` unchanged - the same two
`agno_migrator` pools (primary for writes, replica for cross-schema
source reads), the same transaction/upsert/`mv_lineage`-update shape,
the same `data_as_of`-from-a-real-observation-timestamp discipline
(`shift_assignments.updated_at`/`leave_request.decided_at` for cost-vs-
budget; `employees.updated_at` for attrition - never a nominal date/period
boundary, the bug class Phase 2 already found and fixed once).

## Blast radius

- One new migration (`1700006000000-CostVsBudgetAttritionBySiteTables.ts`)
  creating both tables and amending both views' `mv_lineage` descriptions
  to what this phase actually ships (ADR-0109 for `mv_cost_vs_budget`
  specifically).
- Two new refresh job services, registered in the existing `RefreshModule`
  - no new pool, no new role, no `app.module.ts` change (`RefreshModule`
    was already imported in Phase 2).
- One new ADR (0109).
- Zero modification to any Module 02/04/06 table, migration, schema, or
  running code - this phase only reads `org.employees`/`org.org_units`/
  `scheduling.shift_assignments`/`attendance_leave.leave_request`, never
  writes them, and reads via the replica.
- This phase's own real verification required seeding a small amount of
  cross-module-consistent test data (a `forecast_run`/`schedule_job`/
  `schedule`/three `shift_assignments`, a `leave_type`/`leave_request`, one
  employee's `termination_date`) into the shared local dev database, since
  the existing fixtures across `org`/`scheduling`/`attendance_leave` were
  independently generated by each module's own prior verification and did
  not share consistent employee/tenant IDs - a pre-existing gap in this
  dev environment's fixture consistency, not a change to any other
  service's code.

## Rollback plan

Delete the two new refresh job service files, remove them from
`RefreshModule`'s `providers` array, run this phase's migration's own
`down()` (drops both tables) - `mv_lineage`'s amended descriptions are not
reverted by `down()` (documentation corrections, not schema), remove this
doc, its checklist, and ADR-0109. Nothing outside this service depends on
either new table yet.

Verified against a real local Postgres and the same genuine streaming
replica Phase 2 stood up (still running, not re-provisioned): both refresh
jobs correctly computed real numbers from real seeded cross-module data,
hand-verified arithmetic (26 scheduled hours = 8+10+8 across three real
shift assignments, 10 overtime hours from the one `is_overtime` shift, 3
approved leave days from a real 3-day leave request, 1 termination
correctly attributed to the correct site via the ltree join). RLS
isolation and the `agno_analytics_app` `SELECT`-only grant were both
verified directly (a tenant session sees only its own rows; a `DELETE`
attempt is rejected with `permission denied`). The full app boots with
both new jobs registered and serves `/healthz`/`/readyz`/`/metrics`.

## Explicit assumptions (spec was ambiguous or silent here)

1. **`mv_cost_vs_budget` reports hours/days, never a dollar figure** - see
   ADR-0109 in full. This is the single largest disclosed deviation from
   §2.2's literal framing in this module's build so far.
2. **Leave days are calendar days, attributed wholly to a request's start
   month** - not working-day-aware, not split across a month boundary.
   Disclosed simplifications (ADR-0109), not precision this data supports.
3. **`mv_attrition_by_site` has no headcount or rate column** - a real
   attrition rate needs a historical point-in-time headcount this phase
   does not reconstruct. Named, not fabricated from today's headcount.
4. **An employee with no `type = 'site'` ancestor anywhere above their own
   org unit produces no row in `mv_attrition_by_site`** - excluded, not
   attributed to a fabricated site. In this platform's real org hierarchy
   (`business_unit` → `department` → `site` → possibly `team`), this
   should be rare but is not structurally impossible (a `business_unit`
   with no `site` child at all).

## Out of scope for this phase (do not build yet)

- Any request path reading either new table. Phase 4.
- A real dollar cost-vs-budget view. Would require a new pay-rate
  capability (most naturally new columns on `org.employees`) and a new
  `Budget`/`BudgetAllocation` entity owned by whichever module is judged
  the right owner - a new, separately-scoped piece of cross-module work
  with its own ADR, not something this phase or module invents alone.
- A real attrition-rate view. Would require `org.employee_history`-based
  historical headcount reconstruction - a new, separately-scoped piece of
  work.
- The custom-metric validation pipeline, BI connector, async exports, the
  NL query bridge, the §0.5 load test, the consistency-check job -
  Phases 5–8, unchanged from Phase 1/2's own list.
