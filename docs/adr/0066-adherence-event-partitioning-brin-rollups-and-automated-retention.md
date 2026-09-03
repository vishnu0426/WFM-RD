# ADR-0066: `AdherenceEvent` is daily-partitioned with BRIN indexes and app-level `@Cron` rollup/retention automation — the ClickHouse→Postgres mitigation for Module 05

## Context
§1 overrides the source spec's ClickHouse choice for Module 05's historical
store to Postgres, platform-wide, same override every other module already
applies to its own source-spec datastore choice. §3.4 is explicit that this
override isn't free: it names the concrete mitigation required to carry a
ClickHouse-shaped access pattern (high-volume append-only writes,
aggregate-heavy trend reads) inside Postgres — daily-range partitioning
with an *automated* creation job, pre-aggregated rollup tables "standing up
from day one," and BRIN indexes "rather than defaulting to a B-tree index
that doesn't fit this write pattern."

Two existing precedents in this platform partition time-series data —
`core.audit_log` (ADR-0005) and `forecasting.forecast_data_points`/
`forecast_accuracy_log` (ADR-0018) — but neither is a complete template:
both are **monthly**, both use plain B-tree indexes, neither has a
rollup table, and both explicitly *defer* partition rotation to
`pg_partman` (infra tooling) as an accepted, documented gap. A grep across
this entire monorepo confirms no `pg_cron`, materialized view, or rollup
table exists anywhere — this phase establishes that pattern for the first
time, not copies one.

## Decision
**Daily**, not monthly, `PARTITION BY RANGE ("timestamp")` on
`intraday.adherence_event` — a deliberate departure from the two existing
precedents. `AdherenceEvent` is written once per `agent.state_changed`
event (potentially one row per employee per activity transition, at
100k+-employee scale per §0.5) — a materially higher write-volume time
series than either `audit_log` or `forecast_data_points`, and closer to
the ClickHouse-shaped pattern §3.4 is explicitly mitigating. Composite PK
`(id, "timestamp")` (Postgres requires the partition key in every unique
index, same shape both precedents already use). No `DEFAULT` partition —
same fail-closed posture as ADR-0005: an insert into an unprovisioned day
fails loudly, never lands in a silent catch-all.

**A BRIN index on `"timestamp"`** — this platform's first — created once
on the parent table (PG11+ propagates matching indexes to every existing
and future partition automatically). Justified by the same reasoning §3.4
states directly: `adherence_event` rows arrive in natural timestamp order
(append-only, one row per real-time transition), which is exactly BRIN's
best case and a B-tree's worst case at this row-count scale.

**Two rollup tables**, `intraday.adherence_hourly_rollup`/
`adherence_daily_rollup`, keyed `(tenant_id, employee_id, bucket_start)`
— **not** `org_unit_id`, despite §3.4's own text naming
`tenant_id`/`org_unit_id`. No payload anywhere in this platform's intraday
pipeline (`AgentStateChangedPayload`, `AdherenceEvent` itself) carries
`org_unit_id` — resolving it would mean a new cross-service enrichment
call to Module 02 at write time, real scope this phase doesn't take on.
Maintained by `AdherenceRollupSchedulerService`'s hourly `@Cron` tick
(incremental `INSERT ... SELECT ... GROUP BY ... ON CONFLICT DO UPDATE`
over a bounded trailing window, not a full-table rescan every tick) —
an app-level job, not `pg_cron`, matching this platform's own established
idiom (`ShiftStartPreloadSchedulerService`, Phase 2) rather than
introducing a new infra dependency with zero prior art anywhere in this
codebase to justify it.

**`AdherencePartitionSchedulerService`'s daily `@Cron` tick** creates the
next 2 days' partitions and drops partitions older than 95 days (90-day
hot window per §3.4, plus a small safety buffer) — the automated job §3.4
explicitly asks for, closing the exact gap ADR-0005/ADR-0018 both left
open on the theory that daily partitions age out roughly 30× faster than
monthly ones, so deferring creation the same way would mean writes start
failing within about a week of a real deployment, not a comfortable
multi-month runway.

**Both scheduler jobs use a separate, narrowly-scoped, `agno_migrator`-
credentialed connection** (`database/migrator-pool.provider.ts`), not the
runtime `agno_intraday_app` role every other query in this service uses.
This is a deliberate, considered departure from "the running app only
ever holds the least-privilege role," made for two independent reasons:
partition creation/drop is DDL, which `agno_intraday_app` structurally
cannot do (no `CREATE` grant on `intraday`, by design, in the migration);
and rollup aggregation is genuinely cross-tenant (one tick aggregates
every tenant's events), while RLS's `ENABLE`-not-`FORCE` posture
(ADR-0002) means only the table *owner* queries across tenants without
per-request `app.current_tenant_id` scoping. Both jobs are internal
maintenance work, never user-facing data access, and the migrator
connection is used by exactly these two call sites — see that provider
file's own doc comment for the boundary.

## Consequences
- `agno_intraday_app` (the runtime role every consumer/API path uses)
  keeps the platform's standard least-privilege posture: SELECT/INSERT
  only on `adherence_event` (append-only at the grant level, same posture
  as `core.audit_log`'s REVOKE UPDATE/DELETE), SELECT/INSERT/UPDATE on the
  rollups, no DDL rights at all. The migrator-credentialed exception is
  narrow and named, not a general widening.
- Cold-storage export of a partition before it's dropped (§3.4's "moved to
  cheaper storage") is **not** built here — the same class of accepted gap
  ADR-0005/ADR-0018 already carry for `pg_partman`, now a third instance
  of it. By the time a partition is dropped, its data is already captured
  in both rollup tables, so this is aggregate-preserving, not silent data
  loss — but the raw per-event rows are genuinely gone after 95 days, not
  archived anywhere.
- Org-unit-level rollups don't exist. A future phase (or Module 09 itself)
  needing them will need to either add `org_unit_id` to the intraday NATS
  payloads (a Module 05 change) or join `adherence_event`/the rollups
  against Module 02's employee→org-unit mapping downstream, by
  `employee_id` — not solved here.
- Daily partitioning at 100k+-employee scale means a meaningfully higher
  partition count over time than the monthly precedents accumulate — the
  95-day retention window bounds this to roughly 100 live partitions at
  steady state, not unbounded growth, but this is a real operational
  characteristic worth watching in the Phase 7 load test, not assumed away.
