# Module 09 Phase 1 Production Readiness Checklist

Honest split between what this phase's code actually delivers and what is
genuinely a later phase's work, matching every prior module's phase-1
checklist format and honesty bar. This module carries one unusually large
Phase-1 architectural decision (ADR-0108: the full §0.6 ClickHouse/Kafka
override, reconciled against this platform's actual shared-database
topology and ADR-0098's already-superseded-once cross-module-read
precedent) — the design doc's Problem section is longer than a typical
Phase 1 as a direct result, not scope creep.

## Delivered in this phase (application code)

- [x] Full §2.1 schema — `saved_report`, `metric_definition`,
      `dashboard_widget` — plus the §2.2 `analytics_mv` schema skeleton and
      its `mv_lineage` documentation table, across two migrations
      (`1700004000000-InitialAnalyticsSchema.ts`,
      `1700004100000-SeedMvLineage.ts`), new `analytics`/`analytics_mv`
      schemas/`agno_analytics_app` role (ADR-0108), RLS on the three
      `analytics` tables (ADR-0002 convention on `saved_report`/
      `dashboard_widget`; ADR-0095's split policy on `metric_definition`),
      tenant-id-first indexes, `varchar`+`CHECK` enums (ADR-0003).
      `mv_lineage` has no RLS by design (not tenant data).
- [x] `mv_lineage` seeded with all four planned views' lineage
      (`mv_adherence_trend_rollup`, `mv_forecast_accuracy_trend`,
      `mv_cost_vs_budget`, `mv_attrition_by_site`) — source tables/owning
      module, refresh cadence, query pattern — documented before any of the
      four exist as a real `MATERIALIZED VIEW` object, per §2.2's own
      instruction.
- [x] `mv_lineage_data_as_of_not_after_refresh_check` makes §2.3 rule 1's
      "`dataAsOf` never reads newer than the refresh that produced it"
      guarantee schema-structural, not an application-layer convention.
- [x] §2.1's platform-default/tenant-override model for `MetricDefinition`
      is real at the RLS-policy level, not just documented intent: a tenant
      connection can read a platform-default metric and can never write one,
      verified by both the migration's own unit test and a real-Postgres
      check (see below). Name-uniqueness is enforced by two partial unique
      indexes specifically because a plain composite constraint would not
      catch a platform-default collision (ADR-0095's precedent).
- [x] TypeORM entity classes for all four tables (`src/analytics/entities/`),
      each backed by a TS `enum` for its `varchar`+`CHECK` columns.
- [x] `/healthz` (liveness, no dependency checks) / `/readyz` (primary
      Postgres `SELECT 1`-blocking, `degraded` on failure — explicitly does
      not check the Phase-2 read replica) / `/metrics` (Prometheus text
      exposition: `http_request_duration_seconds`/`_total`, plus four
      module-specific metrics declared now against §0.5/§7's SLOs even
      though nothing records into them until Phase 2/3/4/5/8:
      `analytics_mv_refresh_lag_seconds`, `analytics_mv_refresh_job_runs_total`,
      `analytics_replica_lag_seconds`, `analytics_metric_queries_total`,
      `analytics_consistency_check_discrepancies_total`).
- [x] Standard REST error envelope (`{ error: { code, message } }`) via
      `DomainErrorFilter`, tenant-context header-trust placeholder
      (ADR-0014's convention) via `TenantContextMiddleware`/`Service`.
- [x] OpenTelemetry auto-instrumentation wired at boot, same import-order
      constraint and no-op-safe-without-a-collector posture as every other
      service's `tracing.ts` in this platform.
- [x] `scripts/init-roles.sql` additively gains `agno_analytics_app` and
      the `analytics`/`analytics_mv` schema block; `observability/prometheus.yml`
      additively gains the `agno-wfm-analytics-reporting-service` scrape job
      (port 8600) — every existing role/schema/job entry untouched.
- [x] One ADR written now, per this platform's Phase 1 convention: ADR-0108
      (the full §0.6 ClickHouse/Kafka override — read replica of the shared
      instance, not per-module databases; `agno_migrator`-reuse for
      cross-schema source reads per ADR-0098, not a new role; no
      speculative NATS consumer).
- [x] Unit test coverage for entity/migration shape (all four tables' RLS
      policies including the nullable-tenant-id split, the upsert-relevant
      unique constraints, the `mv_lineage` seed row shape and the
      `data_as_of <= refreshed_at` check, enum value sets) — no live
      Postgres required to run `npm test`.
- [x] No `docker-compose.yml` change needed — this service boots and serves
      `/healthz`/`/readyz`/`/metrics` against the already-running `postgres`
      container docker-compose already provisions, once `npm run
      migration:run` has been run against it.
- [x] Verified against a real local Postgres, not just unit tests:
      `scripts/init-roles.sql`'s additive block applies cleanly, both
      migrations execute end to end, the built app boots and serves
      `/healthz`/`/readyz`/`/metrics` using the least-privilege
      `agno_analytics_app` role, RLS actually blocks a cross-tenant read on
      `saved_report`, and `metric_definition`'s ADR-0095-style split policy
      actually lets a tenant session read a platform-default row while
      rejecting that same session's attempt to write one.

## Explicitly NOT done here (needs a later phase)

- [ ] **Any request path that actually writes these tables.** This phase is
      schema/migrations only — there is no controller, resolver, or service
      method anywhere in `analytics-reporting-service/` yet. Do not treat a
      clean `migration:run` as evidence any mutation logic works; none
      exists to test.
- [ ] **The analytics read replica and any code that connects to it.** No
      `docker-compose.yml` container, no `ANALYTICS_REPLICA_DB_*`-backed
      connection pool of any kind exists yet — `.env.example` declares the
      placeholder variables, unused. Phase 2.
- [ ] **The materialized-view refresh runner and any populated
      materialized view.** All four `mv_lineage` rows have `NULL`
      `refreshed_at`/`data_as_of`/`last_run_status` — nothing has ever run a
      refresh, and no `mv_adherence_trend_rollup`/`mv_forecast_accuracy_trend`/
      `mv_cost_vs_budget`/`mv_attrition_by_site` object exists as a real
      Postgres relation anywhere. Phase 2 (single-source) / Phase 3
      (cross-module).
- [ ] **`GET`/dashboard/report-builder/BI-connector reads of any kind.** No
      GraphQL module, resolver, or REST controller for this module's actual
      API surface (§4) exists in this service. `dataAsOf` is not wired to
      anything because nothing produces a response for it to be attached
      to. Phase 4.
- [ ] **The custom-metric dry-run validation/cost-tiering pipeline.**
      `metric_definition.validated_at`/`estimated_cost_tier` exist as
      nullable columns; no code path ever sets either. A `MetricDefinition`
      inserted directly today would have no cost tier and could not
      legitimately back a live widget under §0.5/§2.3 rule 2 — there is
      simply no insert path yet to worry about this for. Phase 5.
- [ ] **The BI connector REST endpoint and async export job.** No
      `GET /v1/analytics/metrics/{metricName}`, no
      `POST /v1/analytics/exports`, no job queue, no export-file storage of
      any kind. Phase 6.
- [ ] **`askAnalyticsQuestion` and the NL query bridge to Module 10.** No
      code in this service calls or is called by Module 10. Phase 7.
- [ ] **The §0.5 release-gate load test.** The source spec's own flagged
      query-performance-at-scale gap (§3/§6.1) is not closed by this phase —
      it is closed by Phase 8's load test actually running against a
      synthetic dataset at target scale and the refresh-cadence/replica-
      sizing decisions in ADR-0108/this doc being revisited with real
      numbers if the test says otherwise. Nothing in this phase should be
      read as "the performance problem is solved."
- [ ] **The consistency-check job (§2.3 rule 4).** No scheduled job compares
      any materialized view's aggregate against a fresh read of its source
      tables, because no materialized view exists yet to check.
      `analytics_consistency_check_discrepancies_total` is declared, not
      measured. Phase 8.
- [ ] **§0.5's per-query-pattern SLOs (dashboard p95 < 1s, ad hoc report
      p95 < 5s) and both replica-lag/refresh-lag on-call pages are declared
      but not measured**, because nothing that could violate or trigger
      them exists yet. Do not read a metric's existence as evidence the SLO
      is met or even measurable today.
- [ ] **Cross-tenant benchmark reporting.** Explicitly out of scope for this
      entire module (§6.2), not a gap this or any later phase closes.
- [ ] **Terraform for real Postgres/replica provisioning, Vault for
      credential issuance.** Same gap already flagged in every prior
      module's own Phase 1 checklist — not re-litigated per module.
- [ ] **In-process or gateway-level rate limiting, penetration testing /
      SOC2 / ISO27001, SAST / dependency scanning / SBOM.** Same explicit
      non-goals already stated platform-wide for Phase 1 of every module.
