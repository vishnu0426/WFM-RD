# ADR-0018: `forecast_data_points`/`forecast_accuracy_log` — `PARTITION BY RANGE`, monthly

## Context
`forecast_data_points` is, by construction, the highest-row-count table in this
schema: one row per interval (e.g. every 15/30 minutes) per `ForecastRun`, and a
tenant can request overlapping/re-run forecasts across many org units. Unlike
Module 02's `Employee`/`EmployeeHistory` (ADR-0010), this isn't bounded by
"one row per entity plus mutations" — it's an open-ended time series, the same
shape `audit_log` has (ADR-0005), not the shape `Employee` has. `forecast_accuracy_log`
grows at the same rate (one row per data point once actuals land) and shares the
same query pattern: "give me accuracy/forecast data for org unit X over date range
Y," which is inherently a time-bounded query, and shares the same eventual
retention need — old forecast data points for dates long past have no operational
value once actuals have superseded them, and should eventually be archived/dropped,
same as old audit log partitions.

## Options considered
1. **`HASH (tenant_id)`, matching ADR-0010's `Employee` precedent.** Rejected:
   `Employee` is bounded per-tenant (headcount), so HASH's benefit is spreading a
   bounded-but-large row count evenly. `ForecastDataPoint` has no such bound — a
   tenant re-running forecasts repeatedly grows this table without limit
   regardless of headcount, and HASH partitioning gives no help with the
   time-based retention/archival story this table will eventually need (dropping
   a HASH partition drops a slice of *every* tenant's data, not "everything older
   than N months").
2. **`RANGE (interval_start)`, monthly** (chosen), matching ADR-0005's
   `audit_log` precedent exactly, for the same reason: retention/archival by
   time is the operationally meaningful unit here, not retention/archival by
   tenant.

## Decision
`forecasting.forecast_data_points` is `PARTITION BY RANGE (interval_start)`,
monthly partitions, current month ± 1 created by the Phase 1 migration (same
bootstrap-only scope as `audit_log`'s Phase 1 partitions — production rotation is
explicitly infra/process work, not application code, same as ADR-0005 already
established). `forecasting.forecast_accuracy_log` uses the same strategy,
partitioned on `evaluated_at`. RLS is declared once on each parent table;
Postgres propagates it to partitions automatically (same as ADR-0005).

## Consequences
- Composite primary keys: `forecast_data_points` PK becomes
  `(id, interval_start)`, `forecast_accuracy_log` PK becomes `(id, evaluated_at)`
  — Postgres requires the partition key in every unique index on a partitioned
  table, identical consequence to `audit_log`'s PK in ADR-0005. Global uniqueness
  of `id` is UUIDv4-generated, not DB-enforced across partitions, same accepted
  gap.
- No `DEFAULT` partition, deliberately — an insert into an unprovisioned month
  fails closed rather than silently landing in a catch-all, same operational
  argument ADR-0005 makes. Flagged in the production readiness checklist as a
  `pg_partman`-or-equivalent ops item, not solved by this migration.
- Every other Phase 1 table (`forecast_models`, `forecast_runs`, `special_events`,
  `scenario_simulations`, `data_quality_checks`, `idempotency_keys`) is
  unpartitioned — their row counts scale with tenant × org-unit × model-type
  counts, not with an open-ended time series, so partitioning them now would be
  the same premature-optimization mistake ADR-0010 explicitly avoided by not
  choosing RANGE-by-tenant for `Employee`.
