# Module 05 Phase 3 Design Doc — Intraday/Real-Time Management: Adherence Calculation + Postgres Historical Store

**Status:** Approved for implementation
**Owner:** Intraday pod (Module 05) — Principal Performance Engineer (Redis/
NATS/Postgres write-path design, per §0).
**Scope:** §2.1's `AdherenceEvent` entity (partitioned daily writes), the
§3.4 rollup-table strategy (`adherence_hourly_rollup`/`adherence_daily_rollup`),
BRIN indexing, automated partition creation/retention, and the deviation
calculation itself (`AdherenceCalculatorConsumerService`, a second,
independent consumer of `agent.state_changed` alongside Phase 2's Redis
state updater). No live-read API for any of this (GraphQL/REST — Phase 4).
No alert pipeline (Phase 5). This is `intraday-service`'s first Postgres
presence — no `AdherenceEvent` row existed anywhere before this phase.

## Problem

Redis is explicitly never a system of record (ADR-0062) — every state
transition that matters for compliance/analytics has to land somewhere
durable, and nothing has written anywhere durable since this service was
created. Three real design gaps had to be closed, not just implemented
against an existing template:

1. **`intraday-service` has zero Postgres presence.** Standing one up
   means the full multi-tenant/RLS/partitioning apparatus this platform
   already has conventions for (ADR-0002/0005/0016/0052) — reused, not
   reinvented.
2. **§3.4 explicitly asks for an automated partition-creation job and a
   rollup strategy "standing up from day one"** — a stricter bar than the
   two existing time-partitioned tables in this platform (`core.audit_log`,
   `forecasting.forecast_data_points`), both of which defer rotation to
   `pg_partman` as an accepted gap and neither of which has a rollup table
   or a BRIN index. No `pg_cron`/materialized-view/rollup precedent exists
   anywhere in this monorepo (confirmed by grep across every service) —
   this phase establishes the pattern, using this platform's own
   established idiom (an app-level `@Cron` job, matching
   `ShiftStartPreloadSchedulerService`'s Phase 2 shape) rather than a new
   infra dependency.
3. **Two independent NATS consumers on the same subject, one of which
   needs "the previous value."** `AgentStateChangedConsumerService`
   (Phase 2) and this phase's adherence calculator both react to
   `agent.state_changed` independently. Naively reading "the previous
   activity" off Redis would race with the other consumer, which might
   already have overwritten it with *this same event's* new value. See
   ADR-0067 for the fix (a self-referential Postgres lookup instead).

## Decision

See ADR-0066 (storage engineering: daily partitioning, BRIN, rollups,
automated creation/retention, the migrator-pool exception for the two
scheduler jobs) and ADR-0067 (calculation semantics: the coarse
adherent/non-adherent rule, the race-free `from_activity` lookup, the
deterministic `deviation_seconds` definition) for full reasoning. Summary:

- New `intraday` Postgres schema + `agno_intraday_app` role in the shared
  `agno_wfm` database (ADR-0052's unchanged pattern), provisioned via
  `scripts/init-roles.sql` (additive) and this service's own first
  migration (`src/database/migrations/1700000200000-InitialAdherenceSchema.ts`).
  `agno_intraday_app` gets SELECT/INSERT (never UPDATE/DELETE — append-only,
  same posture as `core.audit_log`) on `adherence_event`, SELECT/INSERT/UPDATE
  on the two rollup tables, no CREATE on the schema at all.
- `intraday.adherence_event`: `PARTITION BY RANGE ("timestamp")` daily,
  composite PK `(id, "timestamp")`, no `DEFAULT` partition, a tenant-first
  B-tree index for point lookups plus a BRIN index on `"timestamp"` (this
  platform's first). Bootstrap: today ± 3 days.
- `intraday.adherence_hourly_rollup`/`adherence_daily_rollup`: keyed
  `(tenant_id, employee_id, bucket_start)`.
- `AdherenceCalculatorConsumerService`: a second durable JetStream consumer
  on `agno.intraday.agent.state_changed.v1.>` (own `durableName`, same
  `DurableJetStreamConsumer<TPayload>` base class Phase 2 established).
  Reads the employee's most recent `AdherenceEvent` row for `from_activity`,
  reads Redis for `scheduledActivity`, inserts a new row via
  `IntradayRedisService`'s established partial-write-adjacent pattern (own
  `withTenantConnection` helper — a copy of the root app's
  `withTenantTransaction`, simplified — sets `app.current_tenant_id` for
  RLS before every query). A Postgres write failure `nak()`s (redelivers)
  rather than silently dropping the row.
- `AdherenceRollupSchedulerService` (`@Cron('0 * * * *')`) and
  `AdherencePartitionSchedulerService` (`@Cron('0 1 * * *')`): both use a
  dedicated, narrowly-scoped `agno_migrator`-credentialed connection
  (`database/migrator-pool.provider.ts`) — DDL and cross-tenant aggregation
  respectively, neither of which the least-privilege runtime role can or
  should do. Every other code path in this service continues to use
  `agno_intraday_app` exclusively.
- `/readyz` gains a Postgres check, reported but **non-fatal** — the
  deliberate opposite of Redis's fail-visible/fatal posture (ADR-0062):
  Postgres backs an independent pipeline this service's ingestion/Redis
  dashboard functionality doesn't depend on, so an outage should show up
  as consumer lag, not as this instance refusing all traffic.

## Blast radius

New `intraday` schema/role/tables in the shared `agno_wfm` database
(additive — zero change to `core`/`org`/`forecasting`/`scheduling`).
Additive edit to `scripts/init-roles.sql`. New `src/adherence/` and
`src/database/` in `intraday-service`, wired into `app.module.ts`
alongside Phase 1/2's modules — no change to the ingestion, Redis, or
Phase 2 schedule-sync code paths; `AgentStateChangedConsumerService`
itself is untouched. No `docker-compose.yml` change.

## Rollback plan

Revert the `init-roles.sql` addition, run the migration's `down()` (`DROP
SCHEMA intraday CASCADE`), delete `src/adherence/`/`src/database/` and the
new dependencies (`typeorm`, `pg`, `@nestjs/typeorm`). Nothing outside this
phase's own new module depends on it — Phase 1/2's Redis pipeline is fully
independent of whether this phase's Postgres pipeline exists at all.

## Explicit assumptions (spec was ambiguous or silent here)

1. **`deviation_seconds`'s exact formula** — see ADR-0067; genuinely
   underspecified, a documented interpretation, not the only possible one.
2. **Rollups are keyed by `(tenant_id, employee_id)`, not `org_unit_id`** —
   see ADR-0066's consequences.
3. **`/readyz`'s Postgres check is reported-but-non-fatal** — a deliberate
   asymmetry with Redis's fatal posture.
4. **TypeORM's single-row insert against the composite-PK partitioned
   table has no confirmed prior-failure precedent in this repo** — ADR-0056
   documents an analogous SQLAlchemy-specific multi-row `insertmanyvalues`
   bug, not a TypeORM one, and this consumer only ever inserts one row at
   a time (not a batch), which is the specific case that bug doesn't apply
   to even in SQLAlchemy. Verified empirically against real Postgres
   during this phase's own verification pass, not just assumed safe.
5. **Cold-storage export of dropped partitions is not built** — same class
   of accepted gap `pg_partman` already represents for ADR-0005/ADR-0018,
   now a third instance, flagged explicitly rather than silently absent.

## Out of scope for this phase

- Any live-read API surface for `AdherenceEvent`/rollups (GraphQL/REST) —
  Phase 4.
- Alert pipeline, `ReallocationAction` — Phase 5/6.
- §6.1's full degradation contract, the 100k+-agent load test,
  horizontal-scaling-safe consumer partitioning (this consumer, like
  `AgentStateChangedConsumerService`, assumes a single running instance) —
  Phase 7.
- Multi-region — Phase 8.
- Org-unit-level rollups, cold-storage partition archival (see assumptions
  2 and 5).
- A richer, activity-code-based adherence taxonomy — blocked on
  scheduling-service growing one (ADR-0064's own flagged gap).
