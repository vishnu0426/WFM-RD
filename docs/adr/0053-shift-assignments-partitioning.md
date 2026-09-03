# ADR-0053: `shift_assignments` partitioned `RANGE` monthly on `shift_start`

## Context
The module prompt's §0.5 treats 100k+ employee scale as a load-bearing,
day-one planning concern for this module specifically ("do not mark this
module 'done' without an actual load test... this is exactly the kind of
item that's easy to leave as an assumption and expensive to discover wrong").
`shift_assignments` is this module's analogue of `audit_log` (ADR-0005) and
`forecasting.forecast_data_points`/`forecast_accuracy_log` (ADR-0018): one row
per employee per shift, re-generated on every re-optimization, unbounded in
row count as a function of tenant count × employee count × schedule cadence —
not bounded the way `schedule_jobs`/`schedules` are (one row per solve /
per published schedule, not per employee-shift).

## Decision
`scheduling.shift_assignments` is `PARTITION BY RANGE (shift_start)`, monthly,
same mechanism and same Phase 1 bootstrap scope as the two precedents above
(current month ± 1, no `DEFAULT` partition — an insert into an unprovisioned
month fails closed rather than silently landing in a catch-all). Primary key
is `(id, shift_start)`, not bare `id`, for the same reason `forecast_data_points`
uses `(id, interval_start)`: Postgres requires the partition key in every
unique/primary key on a partitioned table.

`schedule_jobs`, `schedules`, `schedule_explanations`, and `schedule_conflicts`
stay unpartitioned — their row counts are bounded by solve/publish frequency
(one row per job, one row per published schedule, one row per detected
conflict), not by employee count, matching `forecast_models`/`forecast_runs`'s
same unpartitioned treatment in ADR-0018.

## Consequences
- Same accepted gap as `audit_log`/`forecast_data_points`: this migration only
  creates bootstrap partitions for the current month ± 1. Production partition
  rotation (`pg_partman` or equivalent) is infra/process work, not built here —
  carried forward in the production readiness checklist, not silently assumed
  solved.
- `locked = true` (manual-override/swap/bid) rows persist across
  re-optimization runs (§2.2 rule 1) — partitioning by `shift_start` is safe
  for that requirement since a locked assignment's `shift_start` doesn't move
  when it's carried into a new solve; only its `schedule_id` does, via a new
  row on the new `Schedule`, never an `UPDATE` of the old one.
- Decomposition (§7.1, Phase 7) will read/write `shift_assignments` scoped to
  one `org_unit_id`/date-range sub-problem at a time; RANGE-by-time
  partitioning composes with that access pattern (each sub-problem's writes
  land in a small number of partitions) rather than fighting it the way a
  hash partition on `id` would.
