# ADR-0108: Module 09 reads other modules' Postgres tables through one streaming read replica of the shared instance and its own materialized views, not a new ClickHouse cluster fed by Kafka

## Context
The source spec's architecture for Module 09 (Analytics & Reporting) is built
entirely around ClickHouse as the query store and Kafka as the sink-feeding
pipeline: "primarily a query layer over ClickHouse... this module adds zero
new ingestion." Both are banned platform-wide (ADR-0043 for NATS JetStream
over Kafka everywhere else; no ClickHouse has been introduced in Modules
01-08). Unlike prior per-module Kafka→NATS swaps, this cannot be a label
swap: the source design's entire performance story (fast cross-module
aggregation without hitting every owning module's primary) depends on
ClickHouse's existence, so removing it requires an actual replacement
mechanism, not a find-replace.

The module's own non-negotiable, stated up front, is that Module 09 must
never become a second source of truth and must never recompute a fact
another module already owns (e.g. it reads Module 08's `AdherenceScore`; it
does not re-derive adherence from raw events). That constraint has to
survive the ClickHouse removal.

Two further facts, discovered while scoping this module rather than assumed
from the source spec, change the shape of the answer:

1. **There is no per-module database.** ADR-0093 (and its Module 03-07
   analogues) established one shared Postgres instance, `agno_wfm`, with a
   dedicated schema and least-privilege role per module (`forecasting`,
   `scheduling`, `intraday`, `attendance_leave`, `marketplace`,
   `compliance`, `org`/`core`) — not one database per module. The source
   spec's "dedicated read replicas of each owning module's database" phrase
   assumes a topology this platform doesn't have.
2. **This platform has already made, and lived with, the specific decision
   of how one module reads another module's already-computed data, twice.**
   ADR-0094 (Module 08 reading Module 05's rollups) chose a direct
   scheduled Postgres read over a NATS-JetStream-consumption alternative —
   because a job re-deriving from a raw event stream risks producing a
   *different* number than the owning module's own computation for the same
   period, and because polling on a schedule loses nothing a streaming
   consumer would have bought when there's no real sub-window latency
   requirement. That reasoning applies to Module 09 without modification:
   it is the same "one ingestion path per fact, many read consumers"
   principle the source spec's Kafka/ClickHouse section was itself trying
   to express, just pointed at the right datastore. ADR-0094's *mechanism*
   for that read, however, was superseded same-phase by ADR-0098: rather
   than a dedicated connection authenticated as the owning module's own app
   role (`agno_intraday_app`), the actual implementation reuses
   `agno_migrator` — the migration role every service already holds, which
   already owns every schema in the shared instance and structurally
   bypasses RLS as each table's owner — via a small per-service
   `migratorPoolProvider` (first written for intraday-service/attendance-
   leave-service, copied into adherence-compliance-service). ADR-0098's own
   words: provisioning a second role/credential "would be new
   infrastructure with no advantage over reusing a credential this service
   already holds." That is the mechanism this ADR reuses for Module 09's
   own cross-schema source reads (see Decision) — not ADR-0094's original,
   superseded design.

Three options were considered for Module 09's actual read mechanism:

1. **New ClickHouse cluster fed by a new Kafka/NATS sink pipeline per
   source module**, as the source spec describes. Rejected: reintroduces
   Kafka and a banned datastore, and requires a second ingestion path per
   fact (a sink consumer into ClickHouse) for every fact this module reads
   — the exact duplication the source spec's own stated principle argues
   against, just relocated.
2. **Read other modules' schemas directly against the shared primary**,
   reusing `agno_migrator` per ADR-0098's precedent, with no new
   infrastructure at all. Rejected as the *sole* mechanism, though its
   credential-reuse pattern is adopted for source reads (see Decision):
   this module's read volume is qualitatively different from Module 08's
   one rollup job on a 15-minute tick. An executive dashboard, a report
   builder, and third-party BI tools (§3, §4.2) polling
   `GET /v1/analytics/metrics/{metricName}` are exactly the query load
   ClickHouse existed to isolate from every other module's operational
   primary; running that load straight against the shared primary would
   recreate the isolation problem the source spec correctly worried about,
   even without ClickHouse in the picture.
3. **One streaming physical read replica of the shared `agno_wfm`
   instance, plus Module-09-owned materialized views for the joins no
   single owning module's table can answer alone** — the mechanism this
   ADR adopts.

## Decision
**One streaming (async physical) Postgres read replica of the single
shared `agno_wfm` instance**, plus **Module 09's own materialized-view
schema**, replace ClickHouse. No new database-per-module, no Kafka, no
ClickHouse.

- **Why one replica, not one per owning module:** every module's data
  already lives in one physical instance (ADR-0093), so a single streaming
  replica of that instance is, mechanically, a replica of every owning
  module's schema at once. Postgres roles and grants are cluster-wide and
  replicate with the instance, so a new role scoped to exactly the tables
  Module 09 needs works unmodified against the replica. This is the direct
  Postgres equivalent of "read replicas of each owning module's database" —
  the source spec's plural phrasing described a topology (one DB per
  module) this platform never had, not a requirement for N physical
  replicas.
- **This replica is the load-isolation mechanism that replaces ClickHouse's
  actual job**, stated explicitly per this module's own instructions: it is
  what lets a dashboard load, a report-builder query, or a BI tool's
  polling hit a copy of the data instead of every owning module's
  operational primary. Concretely, three connection pools, no new role
  beyond this module's own (per ADR-0098: provisioning a fresh cross-schema
  role would be new infrastructure with no advantage over reusing a
  credential this service already holds):
  1. `agno_migrator` against the **primary** — this service's own DDL
     (`npm run migration:run`), exactly like every other service.
  2. `agno_migrator` against the **replica** — the MV refresh jobs'
     cross-schema *source* reads (Module 08's `AdherenceScore`, Module 03's
     `ForecastAccuracyLog`, etc.), the direct Postgres extension of
     ADR-0098's `migratorPoolProvider` pattern, just pointed at a different
     host. Used only by scheduled jobs, never a live user-facing query —
     the same restriction every prior use of this credential already
     observes.
  3. `agno_analytics_app` — this module's own least-privilege role,
     scoped to `analytics`/`analytics_mv` only, exactly like every other
     module's own app role. Its writes (`SavedReport`/`MetricDefinition`/
     `DashboardWidget` CRUD, and the refresh jobs' upserts into
     `analytics_mv`) go to the **primary**. Its reads — every live
     dashboard load, report-builder query, and BI-connector request in §3/
     §4 — go to the **replica**, via a second pool with the same
     credentials pointed at a different host. This is what actually
     isolates externally-driven analytics read traffic from the shared
     primary; it needs no new role because Postgres grants replicate with
     the instance, so `agno_analytics_app`'s existing schema-scoped grants
     already apply on the replica unmodified.
- **Module 09's own materialized views** (`analytics_mv` schema:
  `mv_cost_vs_budget`, `mv_attrition_by_site`, `mv_adherence_trend_rollup`,
  `mv_forecast_accuracy_trend`, per §2.2) are the one place this module
  "owns" derived data, and that ownership is deliberately narrow: each view
  is built from the read-replica sources above, refreshed on a scheduled,
  idempotent job (same discipline as every prior rollup job, e.g. ADR-0066/
  ADR-0094), stamped with a `refreshed_at`/`data_as_of` watermark, and
  documented with explicit source-table/owning-module/refresh-cadence
  lineage in a `mv_lineage` metadata table (§2.2) rather than being an
  undocumented shadow warehouse. The owning module's table remains
  authoritative if a view and its source ever disagree; a scheduled
  consistency-check job (§2.3 rule 4) makes that disagreement an alerting
  condition, not a silent discrepancy.
- **No NATS JetStream consumer is built in this module's first phases.**
  §1's table allows NATS JetStream as a supplement for specific
  near-real-time widget needs, but per ADR-0094's reasoning (applied
  here without modification, and doubly true for scheduled dashboard
  refreshes vs. a 15-minute adherence tick): no widget in Module 09's
  current scope has a latency requirement that a scheduled materialized-
  view refresh cannot satisfy, and speculatively building a JetStream
  consumer (durable consumer, offset tracking, redelivery/dedup logic —
  the pattern that exists in `intraday-service` and nowhere else) for a
  need that hasn't materialized would be exactly the kind of guess ADR-0094
  already argued against. If a specific dashboard widget's SLO genuinely
  cannot be met by scheduled refresh, that is a new requirement to bring
  back with its own ADR, not something to build ahead of demand now.
- **Cross-tenant benchmark reporting is out of scope** (§6.2, unchanged
  from the source spec's own flag) — no cross-tenant read path exists
  anywhere in this design, and the per-tenant materialized-view schema is
  not to be repurposed for it without a separate consent/anonymization/
  legal design pass.

## Consequences
- **Net infrastructure change vs. the source spec: negative.** No new
  ClickHouse cluster, no new sink-consumer pipeline. The actual new
  infrastructure is one streaming Postgres replica and one new service's
  worth of schema/compute for its materialized views — smaller and cheaper
  than the source design, and closes a gap this platform's own
  `docker-compose.yml` already names explicitly ("Production Postgres is
  provisioned via Terraform (RDS/Cloud SQL + PgBouncer + read replicas +
  PITR) - not modeled here"): read replicas were a disclosed, deferred gap
  before Module 09 existed, and this ADR is the first thing in this
  platform to actually depend on one existing.
- **`docker-compose.yml` gets no new container for this replica**, per that
  same existing disclaimer - real read-replica provisioning is Terraform's
  job, consistently for the primary and for this replica, not something
  local docker-compose models for any service in this platform. Phase 2's
  application code reads `ANALYTICS_REPLICA_DB_HOST`/`ANALYTICS_REPLICA_DB_PORT`
  (declared in Phase 1's `.env.example`, unset/defaulted to the same
  primary host for a pure local `docker-compose up` where no standby
  exists) - pointed at a real Terraform-provisioned replica in any real
  deployment, and optionally at a developer's own manually-provisioned
  local streaming standby (`pg_basebackup` against the same `postgres`
  container) for anyone who wants to exercise genuine replica semantics
  locally, same "real infra is Terraform's job, local dev gets an honest
  approximation" posture as every other Terraform-deferred gap this
  platform's Phase 1 checklists already carry.
- **Net infrastructure change vs. doing nothing (option 2 alone): one real
  Postgres replica, provisioned the same way this platform provisions
  every other piece of real infrastructure (Terraform, not docker-compose
  or this codebase).** This is the cost of the load-isolation property the
  source spec correctly wanted; it is accepted because dashboard/BI-tool
  read volume is a materially different risk to other modules' write paths
  than one module's periodic rollup job.
- Module 09's Phase 1 (this phase) ships schema only: `SavedReport`/
  `MetricDefinition`/`DashboardWidget` in an `analytics` schema, and the
  `analytics_mv` schema skeleton with `mv_lineage` populated for all four
  planned views, but no replica, no cross-schema role, and no populated
  materialized view yet — those are Phase 2 (single-source views, to prove
  the pattern) and Phase 3 (cross-module joins), per this module's own
  build-phase ordering.
- `dataAsOf`/`data_as_of` becomes a first-class field on every dashboard
  and report response (§0.5, §2.3 rule 1), sourced from each materialized
  view's own refresh watermark — replica lag and refresh-job lag are
  therefore this module's data-freshness story end to end, and both need
  their own SLOs and on-call pages (§0.5), not an assumption that "replica"
  means "current."
- If a future need requires sub-refresh-interval widget freshness that
  scheduled refresh genuinely cannot satisfy, introducing a NATS JetStream
  consumer for that specific case is a new ADR, following `intraday-
  service`'s existing consumer pattern (`DurableJetStreamConsumer`) rather
  than inventing a second one.
