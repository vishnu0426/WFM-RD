# ADR-0109: `mv_cost_vs_budget` reports labor-hours utilization by cost center, not a dollar cost-vs-budget comparison — no pay-rate or budget capability exists anywhere in this platform

## Context
§2.2's own line for this view: "`mv_cost_vs_budget` -- joins Module 02
`cost_center` + Module 04 `ShiftAssignment` (actual hours) + Module 06
overtime/leave-driven cost impact, refreshed daily." Implementing the
actual join (Phase 3) required first answering a question the source spec
never actually answers: **cost and budget in what unit, sourced from
where?** A dollar figure needs a rate (dollars per hour, or a salary) to
convert hours into cost, and a comparison needs a budget figure to compare
against. Neither exists anywhere in this platform - confirmed by
inspecting every schema this module can read (`org`, `scheduling`,
`attendance_leave`, `core`, `compliance`, `forecasting`, `intraday`,
`marketplace`), not assumed from the spec's silence:

- `org.employees` carries `cost_center` (a label) and `contract_hours_per_week`,
  but no `pay_rate`/`hourly_rate`/`salary` column of any kind.
- No table anywhere in this platform (`grep`-confirmed across every
  service's migrations) has a column named anything resembling
  `hourly_rate`, `pay_rate`, `salary`, `wage`, or `budget`.
- Module 09's own §2.1 doesn't own a `Budget`/`BudgetAllocation` entity
  either - this module's own entity list is `SavedReport`/
  `MetricDefinition`/`DashboardWidget` plus its materialized-view schema,
  nothing that could hold a budget figure.

This is the identical class of finding ADR-0098 named for Module 08's
`OccupancyRecord`/`ShrinkageRecord`: a source-spec entity/view whose name
promises a capability ("occupancy," here "cost vs budget") that the data
actually available upstream cannot support, discovered only once real
implementation tried to compute a real number. §0's own non-negotiable for
this module sharpens the stakes further: Module 09 must never
re-derive or re-interpret a fact another module owns, and must never
become a second source of truth. A pay rate or a budget figure invented
inside this module's own refresh job - a placeholder rate, a fabricated
per-tenant budget constant - would be exactly that: a number no other
module asserts, existing nowhere except inside an analytics rollup,
silently presented as if it were real. That is worse than the gap itself.

Three options were considered:

1. **Fabricate a placeholder rate/budget** (e.g. a flat `$25/hour`
   constant, a budget derived from `contract_hours_per_week * some rate`)
   so the view's columns literally read "cost" and "budget" in dollars.
   Rejected outright: this is precisely "don't fabricate a result to fill
   a confirmed gap" (ADR-0098's own words), and a dashboard consumer has no
   way to know the number is invented rather than real.
2. **Skip this view entirely for this phase**, deferring until a real
   pay-rate/budget capability exists somewhere in this platform. Rejected:
   §8's own build-phase list names this view explicitly for Phase 3, and
   the *join* itself (`cost_center` × `ShiftAssignment` × leave/overtime
   impact) is genuinely buildable and useful today - only the dollar
   conversion is blocked, not the whole view.
3. **Ship the view under its existing name, reporting what the join
   actually supports: hours and days, not dollars** - labeled and
   documented as a labor-hours utilization proxy, with the dollar-cost gap
   named precisely rather than papered over. This ADR adopts this option.

## Decision
`mv_cost_vs_budget` (name unchanged from §2.2/Phase 1's seeded lineage -
renaming it would just relocate the confusion, not resolve it) reports,
per `(tenant_id, cost_center, period_start)` month bucket: `scheduled_hours`
(sum of `scheduling.shift_assignments` shift durations for employees in
that cost center), `overtime_hours` (the same sum restricted to
`is_overtime = true` rows), and `approved_leave_days` (count of calendar
days from `attendance_leave.leave_request` rows with `status = 'approved'`,
attributed to the month containing `date_range_start`). No dollar column
of any kind - no `cost`, no `budget`, no `variance` - exists on this table.

- **The join is exactly what §2.2 asked for**: `org.employees.cost_center`
  (Module 02) × `scheduling.shift_assignments` actual/scheduled hours
  (Module 04) × `attendance_leave.leave_request` (Module 06's
  overtime/leave-driven impact, expressed in the days Module 06 actually
  records, not a cost figure Module 06 doesn't compute either). Employees
  with `cost_center IS NULL` are excluded from this rollup, not attributed
  to a fabricated "unknown" bucket - the same "don't fabricate a result"
  posture applied to the grouping key itself.
- **`mv_lineage.source_description` for this view is corrected** in this
  phase's own migration to state plainly what the table contains (hours/
  days, not dollars) and name the two missing capabilities (employee
  pay-rate, budget allocation) that would be required to build the literal
  "cost vs budget" comparison - the same "amend once implementation
  surfaces the real shape" posture ADR-0098/Phase 2's own `mv_lineage`
  correction already established for this module.
- **Leave days are calendar days, not working days** (`date_range_end -
  date_range_start + 1`), and a leave request spanning a month boundary is
  attributed wholly to its start month, not split proportionally - both
  disclosed simplifications, not attempts at precision this data doesn't
  support. Computing working-day-aware, split-by-month leave impact would
  require joining `org.working_time_calendars` per employee and a
  day-series expansion; not attempted here, name-not-fabricate per the
  same standard.
- **If a real pay-rate or budget capability is added to this platform in
  the future** (most naturally as new columns on `org.employees` and a new
  `Budget`/`BudgetAllocation` entity owned by whichever module is judged
  the right owner - not invented inside Module 09, per §0's own
  non-negotiable), extending this view to a real dollar comparison is a
  new, separately-scoped piece of work with its own ADR - not a "fill in
  the placeholder" patch to what ships here.

## Consequences
- `GET /v1/analytics/metrics/mv_cost_vs_budget` (or whatever Phase 4/6
  surface eventually reads this table) returns hours/days, and any UI
  built against it must not label those columns "$" or "cost" without
  itself lying about what the number is. This ADR is the reference for why.
- `MetricDefinition.category = 'cost'` (§2.1's enum) remains available for
  a *tenant-authored* metric that does attempt its own dollar calculation
  from whatever data a tenant chooses to feed a custom `calculation_definition`
  (Phase 5) - that is explicitly the tenant's own responsibility and risk,
  governed by §0.5/§2.3 rule 2's validation/cost-tiering gate, not this
  platform-owned materialized view's.
- This module's non-negotiable ("never re-derive or re-interpret a fact
  another module owns") is upheld by construction: this view derives
  nothing that isn't already a real fact in `org`/`scheduling`/
  `attendance_leave`'s own tables, in the same units those tables already
  use.
- Consistent with ADR-0098's own consequence for Module 08: this is a
  disclosed, load-bearing limitation of the current build, recorded in
  `docs/module-09-phase-3-production-readiness-checklist.md`, not a
  silently narrowed feature.
