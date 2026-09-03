# Module 09 Phase 1 Design Doc — Analytics & Reporting: Schema & Migrations

**Status:** Approved for implementation
**Owner:** Analytics & Reporting pod (Module 09), with a Principal Data
Architect role specifically for §0.6/§3 — this module's entire value
proposition (fast, consistent, non-duplicated cross-module analytics) has
to be achieved without the ClickHouse/Kafka datastore the source spec
assumed, and that is a real architectural problem, decided in ADR-0108, not
a label to swap the way prior modules' Kafka→NATS overrides were.
**Scope:** The §2.1 entity set — `SavedReport`, `MetricDefinition`,
`DashboardWidget` — plus the §2.2 `analytics_mv` materialized-view schema
skeleton and its `mv_lineage` documentation table, seeded with lineage for
all four planned views (`mv_adherence_trend_rollup`,
`mv_forecast_accuracy_trend`, `mv_cost_vs_budget`, `mv_attrition_by_site`).
Two migrations, in a new standalone deployable, `analytics-reporting-
service/` (Node/NestJS), plus the minimal service skeleton needed to run
and verify them: `analytics`/`analytics_mv` schemas + `agno_analytics_app`
role (ADR-0108, extending ADR-0093's pattern), TypeORM data-source/runtime
config, and the platform's standard `/healthz`/`/readyz`/`/metrics` +
tenant-context + domain-error-filter scaffold. **No materialized view
object, no refresh job, no read replica, no metric query engine, no
dashboard/report builder, no GraphQL/REST API surface of any kind, no
NATS.** Those are Phases 2–8 per §8's own build-phase list. This phase does
not call any other module over any transport, and it does not connect to
any owning module's schema — every fact this module will eventually read
stays exactly where its owning module already put it.

## Problem

Module 09 is framed (§0's "how to use this document") as requiring a
genuinely different design from its source spec, not a find-replace
override — the source spec's architecture is built entirely around
ClickHouse as the query store and Kafka as the ingestion pipeline, both
banned platform-wide, and unlike every prior module's Kafka→NATS swap, this
module's actual value (fast cross-module aggregation without hitting every
owning module's primary) depends on ClickHouse's existence. Removing it
needs a real replacement mechanism. Three decisions were worth settling now,
before this phase's schema could even be written, rather than discovered
mid-implementation:

1. **§0.6's flagged architectural override itself.** What replaces "query
   layer over ClickHouse, fed by Kafka" on a platform with no per-module
   database (one shared `agno_wfm` instance, per-module schema+role,
   ADR-0093) and no Kafka (NATS JetStream, ADR-0043)? See ADR-0108: one
   streaming Postgres read replica of the shared instance (Phase 2), plus
   this module's own materialized-view schema for cross-module joins,
   reusing ADR-0098's `agno_migrator`-credential-reuse pattern for
   cross-schema source reads rather than provisioning a new role.
2. **Whether this phase should look ahead to ADR-0094's original mechanism
   or its actual, superseded-same-phase replacement (ADR-0098).** The
   source spec's own "read replicas of each owning module's database"
   phrasing, read naively, suggests re-deriving Module 08's dedicated-role
   pattern. Checking the platform's actual history first (ADR-0098 found
   that a second role/credential for Module 08's own cross-module read
   was strictly worse than reusing `agno_migrator`) meant this module's
   design didn't have to rediscover that lesson itself. `agno_analytics_app`
   (this phase) is scoped to `analytics`/`analytics_mv` only — no cross-
   schema grant, ever.
3. **This module owns the same schema/role decision every prior service
   that stood up new Postgres presence has made** (shared database, new
   schema, new role) — settled, not novel, but still needs its own ADR per
   this platform's convention (ADR-0017/0052/0066/0073/0083/0093
   precedent). Folded into ADR-0108 rather than a separate ADR, since the
   schema/role decision here is inseparable from the read-path decision
   that motivates it.

Beyond those three, this phase follows the precedent every prior module's
Phase 1 set for standing up a new deployable service: reuse the platform's
existing conventions (RLS via `app.current_tenant_id`, `varchar` + `CHECK`
enums per ADR-0003, tenant-id-first indexes, the two-role migrator/app
split, OTel/prom-client/health scaffolding) rather than inventing parallel
ones.

## Decision

A new standalone deployable, `analytics-reporting-service/` (Node/NestJS),
sibling to `attendance-leave-service/`/`shift-marketplace-service/`/
`adherence-compliance-service/` rather than a module folded into root
`src/` — consistent with how Modules 05–08 were each stood up
independently. Runs outside `docker-compose.yml` against the already-
provisioned Postgres container, same as every other Node service — no new
infrastructure container in this phase, and none in Phase 2 either: per
`docker-compose.yml`'s own existing header ("Production Postgres is
provisioned via Terraform ... + read replicas + PITR - not modeled here"),
the read replica Phase 2 depends on is Terraform's job, consistently with
how this platform already treats the primary - not a new `docker-compose`
service.

**Schema** (`src/database/migrations/1700004000000-InitialAnalyticsSchema.ts`
+ `1700004100000-SeedMvLineage.ts`): two migrations, four tables, two new
schemas. `saved_report`/`dashboard_widget` use the platform's ordinary
uniform `tenant_isolation` RLS policy; `metric_definition` uses ADR-0095's
split `USING (... OR tenant_id IS NULL) / WITH CHECK (...)` policy, the same
nullable-tenant-as-platform-default shape `ComplianceRule`/`RetentionPolicy`
established, since a `MetricDefinition` can be a global/platform-default
metric (§2.1's `tenant_id (nullable = global/platform-default)`). `mv_lineage`
gets no RLS — it documents the views themselves (source tables, owning
module, refresh cadence, query pattern), not tenant data, the same posture
this platform gives any other schema-describing metadata table.
`agno_analytics_app` gets `SELECT, INSERT, UPDATE` on the three `analytics`
tables and `SELECT, UPDATE` on `mv_lineage` (rows are seeded once by
migration, never inserted at runtime); no `DELETE` anywhere, no `CREATE` on
either schema.

Constraints worth calling out specifically:
- `saved_report_schedule_cron_scoped_check` — `schedule_cron` only makes
  sense for a `scheduled_export`; a `dashboard`/`ad_hoc` report has no cron
  of its own to run on. Not in §2.1's literal DDL, added the same way every
  prior module's Phase 1 adds a structurally-obvious constraint the source
  spec's field list didn't spell out.
- The two partial unique indexes on `metric_definition` (platform-default
  name uniqueness, tenant-scoped name uniqueness) exist for the same
  `NULL != NULL`-in-a-unique-index reason ADR-0095 documents for
  `compliance_rule`/`retention_policy` — a single composite `UNIQUE` would
  never actually catch two colliding platform-default metric names.
- `mv_lineage_data_as_of_not_after_refresh_check` — `data_as_of <=
  refreshed_at` (or either NULL) — is the schema-level guarantee behind
  §2.3 rule 1's `dataAsOf` field: the instant the data reflects can never
  read as newer than the run that produced it.
- `dashboard_widget`'s FK to `saved_report(id)`/`metric_definition(id)` is
  real; the narrower rule "`dashboard_id` must point at a row where
  `report_type = 'dashboard'`" is application-enforced (Phase 4), not a DB
  CHECK across two tables — same class of assumption call as every prior
  module's Phase 1 when a source-spec relationship needs more than a plain
  FK to fully express.

**Entities** (`src/analytics/entities/`): TypeORM classes mirroring the
migration's DDL exactly, one per table, each with a TS `enum` backing its
`varchar`+`CHECK` columns (ADR-0003's stated split). These exist for
query-building in later phases — nothing in this phase's request path
(there isn't one) touches them yet.

**`mv_lineage` seed data** (`SeedMvLineage`): all four planned views'
lineage documented from day one (§2.2's own instruction), before any of
them exist as a real `MATERIALIZED VIEW` object. `refresh_cadence` is
seeded `'daily'` for all four, including the two §3 flags as hourly
*candidates* "if load testing supports it" — no load test has run yet
(Phase 8's own deliverable), so seeding the honest starting cadence rather
than guessing at one nothing has measured. `refreshed_at`/`data_as_of`/
`last_run_status` all stay `NULL` until Phase 2/3's refresh runner exists.

**Service skeleton**: `TenantContextService`/`Middleware`/`Module` (own
copy, header-trust placeholder, ADR-0014's convention), `HealthController`
(`/healthz` always-200 liveness, `/readyz` primary-Postgres-fatal
readiness — explicitly does *not* check the Phase-2 read replica; replica
lag/reachability is its own SLO and metric, not this endpoint's concern),
`MetricsService`/`Controller`/`Module` (prom-client, `/metrics`),
`DomainError`/`DomainErrorFilter` (typed error envelope, REST-only — no
GraphQL-context bailout yet, since there is no GraphQL context until
Phase 4). `MetricsService` also declares
`analytics_mv_refresh_lag_seconds`/`analytics_mv_refresh_job_runs_total`
(§0.5/§7's per-view staleness SLO), `analytics_replica_lag_seconds` (§0.5's
replica-lag SLO), `analytics_metric_queries_total` (§0.5's cost-tier
distribution signal), and `analytics_consistency_check_discrepancies_total`
(§2.3 rule 4's alerting condition) now, undocumented by any real call site
until Phase 2/3/4/5/8 wire them — declared early so those phases inherit a
settled metric name/label convention instead of inventing one under phase
pressure.

Observability: `observability/prometheus.yml` gains a seventh Node-service
scrape target (`agno-wfm-analytics-reporting-service`, port 8600) —
additive, matching every existing Node service entry's shape.

## Blast radius

- Entirely new directory (`analytics-reporting-service/`) plus this doc,
  its checklist, and one ADR (ADR-0108) — zero modification to any Module
  01–08 table, migration, schema, or running code path.
- Additive edits to two shared files: `scripts/init-roles.sql` gains the
  `agno_analytics_app` role and `analytics`/`analytics_mv` schema block
  (every existing role/schema line untouched); `observability/prometheus.yml`
  gains one new scrape job (every existing job untouched).
- No `docker-compose.yml` change in this phase, nor in any later phase of
  this module — runs as a local process against the already-running
  Postgres container, same posture as every other Node service. The read
  replica Phase 2 depends on is Terraform's job (`docker-compose.yml`'s own
  existing disclaimer), not a `docker-compose` service this module adds.
- No cross-service call of any kind — nothing in this phase depends on any
  other module's running code, and nothing in those services depends on
  this one. In particular, the actual read-replica wiring and MV refresh
  logic ADR-0108 designs is entirely unbuilt; this phase only lays the
  schema those phases write into.

## Rollback plan

Delete `analytics-reporting-service/`, revert the additive blocks in
`scripts/init-roles.sql` and `observability/prometheus.yml`, drop the
`analytics`/`analytics_mv` schemas (`DROP SCHEMA IF EXISTS analytics
CASCADE; DROP SCHEMA IF EXISTS analytics_mv CASCADE;` — the migration's own
`down()`), remove this doc, its checklist, and ADR-0108. Nothing external
references either schema or this service yet, so rollback is a non-event
now — this stops being true once Phase 4 puts real dashboard/report-builder
traffic behind it.

Same platform-wide `migration:revert`-to-zero CLI gap every prior module's
Phase 1 design doc has already documented applies identically here — not
re-litigated per module; read this phase's rollback plan as "drop both
schemas directly."

Verified against a real local Postgres instance (not just unit tests):
`migration:run` executes both migrations cleanly end to end against the
already-provisioned `agno_wfm` database, the built app boots and serves
`/healthz`/`/readyz`/`/metrics` using the least-privilege
`agno_analytics_app` role, RLS actually blocks a cross-tenant read on
`saved_report`, `metric_definition`'s ADR-0095-style split policy behaves
exactly as designed both directions (a tenant session cannot insert a
`NULL`-tenant row but can read a platform-default one seeded by
`agno_migrator`), and all four `mv_lineage` rows are present with `NULL`
`refreshed_at`/`data_as_of` immediately after migration.

## Explicit assumptions (spec was ambiguous or silent here)

1. **Service directory/role name is `analytics-reporting-service` /
   `agno_analytics_app`**, matching the module's own title ("Analytics &
   Reporting") rather than a shorter `analytics-service`, following
   `adherence-compliance-service`'s own precedent of using the module's
   full name rather than one that undersells its scope. **Two schemas**,
   not one — `analytics` (this module's own entities) and `analytics_mv`
   (materialized views + lineage) — because §2.2 explicitly frames the
   materialized-view schema as a distinct thing from this module's own
   entity set ("the one place this module 'owns' derived data," called out
   separately from §2.1's entity list), and keeping them as two schemas
   under one role makes that distinction visible in every grant statement
   rather than only in prose.
2. **No new Postgres role beyond `agno_analytics_app`.** The source spec's
   "dedicated read replicas of each owning module's database" (§0.6) reads,
   naively, as needing a role scoped to each owning module's schema. ADR-
   0108 decided against this: `agno_migrator` already owns every schema
   (ADR-0098's precedent for exactly this class of read), and Postgres
   grants replicate with the instance, so pointing `agno_migrator`
   (source reads) and `agno_analytics_app` (this module's own schema, both
   writes on the primary and reads on the replica) at a different host in
   Phase 2 needs no new credential. Confirmed as this phase's architectural
   commitment even though no code in this phase connects to a replica of
   any kind.
3. **`mv_lineage` is seeded with all four views' lineage now, in a
   migration**, not left for whichever phase first builds the corresponding
   `MATERIALIZED VIEW` object to insert its own row. §2.2's "every
   materialized view definition must document... source tables + owning
   module, refresh cadence, and the specific query pattern it exists to
   serve" reads as a day-one documentation requirement, not a per-view
   afterthought — treating it that way here means Phase 2/3's refresh
   runner has a row to `UPDATE` (`refreshed_at`/`data_as_of`/
   `last_run_status`) rather than needing its own `INSERT`.
4. **`refresh_cadence` is seeded `'daily'` for every view**, including the
   two §3 flags as hourly candidates, deliberately not guessing ahead of
   Phase 8's load test. This is a disclosed placeholder, not a considered
   final cadence — same posture as this platform's other seeded defaults
   (e.g. `RetentionPolicy`'s Phase 7 seed, or
   `ADHERENCE_MAJOR_DEVIATION_THRESHOLD_SECONDS`'s placeholder default).
5. **No NATS client, no `nats` package dependency, anywhere in this
   service**, in this phase or any phase this document can presently
   commit to. ADR-0108 explains why: no widget in this module's current
   scope has a latency requirement scheduled materialized-view refresh
   cannot satisfy, and ADR-0094/0098 already demonstrated what happens when
   a service builds streaming-consumer machinery ahead of an actual,
   confirmed latency need. If a real one surfaces later, it gets its own
   ADR, following `intraday-service`'s existing `DurableJetStreamConsumer`
   pattern rather than a second one.
6. **No gRPC surface, in this phase or any phase this module's own API
   contracts (§4) currently describe.** Unlike Module 08, this module's
   `main.ts` never bolts on a second `Transport.GRPC` microservice — §4
   lists GraphQL and REST only, and every fact this module reads comes from
   Postgres (via the replica, from Phase 2) rather than a synchronous
   cross-module RPC call.

## Out of scope for this phase (do not build yet)

- The analytics read replica (streaming physical replica of the shared
  `agno_wfm` primary, Terraform-provisioned per `docker-compose.yml`'s own
  existing disclaimer — no new `docker-compose` service) and the
  application code that connects to it — Phase 2.
- The materialized-view refresh runner (the `agno_migrator`-against-the-
  replica cross-schema source reads, the `agno_analytics_app`-against-the-
  primary writes into `analytics_mv`, and the actual `CREATE MATERIALIZED
  VIEW`/refresh-and-swap or scheduled `REFRESH` logic for
  `mv_adherence_trend_rollup`/`mv_forecast_accuracy_trend`) — Phase 2.
  `mv_cost_vs_budget`/`mv_attrition_by_site`'s genuinely multi-source joins
  — Phase 3.
- The metric query engine, `dashboard`/`myDashboards`/`metricQuery`/
  `executiveSummary` GraphQL, `createDashboard`/`createScheduledExport`
  mutations, and `dataAsOf` actually appearing on any response — Phase 4.
  No GraphQL module, resolver, or schema exists in this service yet.
- The custom-metric dry-run validation/cost-tiering pipeline —
  `validated_at`/`estimated_cost_tier` exist as columns; nothing writes to
  either yet. Phase 5.
- The BI connector REST endpoint (`GET /v1/analytics/metrics/{metricName}`)
  and the async export job (`POST /v1/analytics/exports` +
  `GET /v1/analytics/exports/{id}/download`) — Phase 6.
- `askAnalyticsQuestion` and the NL query bridge to Module 10 — Phase 7.
- The §0.5 release-gate load test, the consistency-check job (§2.3 rule 4),
  dashboards/runbooks — Phase 8.
- Cross-tenant benchmark reporting — explicitly out of scope for this
  entire build (§6.2), not deferred to a later phase of this module.
