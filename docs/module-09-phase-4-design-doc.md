# Module 09 Phase 4 Design Doc — Analytics & Reporting: Metric Query Engine & Dashboard/Report Builder

**Status:** Approved for implementation
**Owner:** Analytics & Reporting pod (Module 09).
**Scope:** §8's own Phase 4 line: "Metric query engine + dashboard/report builder. GraphQL/REST surface, `dataAsOf` freshness field wired through everywhere." Concretely: `MetricQueryEngineService` (backs both GraphQL's `metricQuery`/`executiveSummary` and REST's `GET /v1/analytics/metrics/{metricName}`), `DashboardService` (`dashboard`/`myDashboards`/`createDashboard`), and this service's first GraphQL surface (`AnalyticsGraphQLModule`). `createScheduledExport` (needs Phase 6's export job) and `askAnalyticsQuestion` (Phase 7) are not registered.

## Problem

This phase's own real-Postgres/real-GraphQL verification caught five real bugs before they could ship - none were review guesses, all were confirmed by an actual failing request or a real constraint/type error:

1. **`SavedReport` has no `name` column.** §4.1's `Dashboard` GraphQL type needs one; §2.1's own DDL never listed one (`config`'s field list is "metrics, dimensions, filters, chart type," no name). Added via this phase's own migration - the table had zero rows since Phase 1, so a plain `NOT NULL` column needed no default/backfill.
2. **GraphQL code-first reflection cannot infer a type for a string-literal-union field** (`trend!: 'up' | 'down' | 'flat' | null`) or, separately, **for any `Date`-typed field marked `{ nullable: true }`/optional** - both threw `UndefinedTypeError` on the very first schema build attempt, not a hypothetical. Fixed by giving every such field an explicit `@Field(() => String, { nullable: true })`/`@Field(() => Date, { nullable: true })` type function rather than relying on reflect-metadata's inference, which only reliably works for concrete non-nullable classes/primitives.
3. **A jsonb input field with no `class-validator` decorator is invisible to `ValidationPipe`'s `whitelist`/`forbidNonWhitelisted` mode** - `CreateDashboardInputType.config`/`CreateDashboardWidgetInputType.position` were being stripped and rejected ("property config should not exist") on the very first real `createDashboard` mutation, because `@Field(() => Object)` alone tells GraphQL how to serialize the field but tells `class-validator` nothing about whether it's an allowed property. Fixed with `@IsObject()` alongside the `@Field` decorator on both.
4. **A parameterized value used twice in one SQL statement, once bare and once inside arithmetic, breaks Postgres's parameter-type inference** even when both uses are the same logical value (`$3` in `VALUES ($1, $2, $3, $3 + interval '1 month', ...)` - `error: inconsistent types deduced for parameter $3`). This is the same class of bug Phase 2/3 already fixed in the refresh jobs' own SQL, now newly relevant because this phase's `readRows` query builds SQL dynamically per source view; fixed the same way, an explicit `::timestamptz` cast on both uses.
5. **A "fetch limit+1 rows so the last result has a real comparison value" query pattern silently drops a genuine result when fewer than `limit+1` rows actually exist.** The very first real `scheduled_hours`/`overtime_hours` REST query against real seeded data (exactly one month on file) returned an empty result set - `shapeResults`' original `rows.length - 1` slice assumed the extra row was always present. Fixed by threading the *originally requested* limit through explicitly and slicing on `Math.min(requestedLimit, rows.length)` - only drop the extra row when the query actually returned more than what was asked for. Covered by a regression test reproducing the exact scenario (one row on file, `limit` defaulting to 12).

A sixth, disclosed-by-design rather than a bug: `mv_cost_vs_budget` is grouped by `cost_center`, which has no tenant-wide or org-unit-scoped total. `executiveSummary(orgUnitId, period)` therefore never includes `scheduled_hours`/`overtime_hours`/`approved_leave_days` - summing across cost centers is not something this query engine's per-row read does, and returning one arbitrary cost center's figure as if it were the tenant's total would misrepresent the number. Named in `MetricQueryEngineService`'s own doc comment, not silently omitted.

## Decision

**`MetricQueryEngineService`** looks up a `MetricDefinition` by name (a tenant-specific override wins over the platform default when both exist - `ORDER BY`-free, via two sequential `findOne` calls inside `withTenantConnection`), validates `calculationDefinition.sourceView`/`valueColumn` against `SOURCE_VIEW_REGISTRY` (a hardcoded whitelist mapping each of the four `analytics_mv.mv_*` tables to its real column names) before building any SQL, then reads exclusively via `ANALYTICS_APP_REPLICA_PG_POOL` (the `agno_analytics_app`-on-replica connection ADR-0108 names as this module's load-isolation mechanism) inside `withTenantScopedClient` (a `BEGIN`/`set_config('app.current_tenant_id', ...)`/`COMMIT` wrapper - the raw-`pg` sibling of the platform's established `withTenantConnection` TypeORM pattern). `dataAsOf` is read from `mv_lineage` on the same connection (no RLS on that table - schema metadata, not tenant data).

**`DashboardService`** is TypeORM-based CRUD against the primary, every method wrapped in `withTenantConnection` - the exact convention `adherence-compliance-service`/`attendance-leave-service`/`shift-marketplace-service` already established for RLS-scoped request-level access (own copy, ADR-0039), confirmed by research before writing a line of this service rather than assumed. `createDashboard` validates every widget's `metricId` exists (tenant override or platform default) and rejects one tiered `estimated_cost_tier = 'expensive'` (§0.5/§2.3 rule 2) - real, enforced code even though none of this phase's six seeded metrics can trigger it yet (verified directly: temporarily tiering a real metric `'expensive'` and confirming the mutation is rejected, then reverting).

**Actor identity** (`X-Actor-Id`, own copy of `shift-marketplace-service`'s ADR-0084 pattern) is this service's first need for "who," not just "which tenant" - `createDashboard`/`dashboard`/`myDashboards` all call `requireActorId()`; `metricQuery`/`executiveSummary`/the REST BI connector do not.

**`GET /v1/analytics/metrics/{metricName}`** (§4.2) ships in this phase, not deferred to Phase 6 as an earlier draft of this module's own phase framing implied - §8's Phase 4 line explicitly says "GraphQL/**REST** surface," and the REST controller is a thin wrapper over the same `MetricQueryEngineService` the GraphQL `metricQuery` resolver uses, so building it here (rather than rebuilding the same capability twice) is the more honest reading of the module's own phase description.

**§2.3 rule 3's `sharedWith`-resolved-via-Module-01-RBAC/ABAC is explicitly not implemented this phase** - no Module 01 RBAC client exists in this service. `getDashboard`/`listMyDashboards` authorize on `createdBy` only, verified directly (a different actor id genuinely cannot read another actor's dashboard, confirmed via a real GraphQL request, not just RLS). This is the single largest disclosed scope gap in this phase - see the checklist.

## Blast radius

- New: `MetricQueryEngineService`, `DashboardService`, `AnalyticsModule`, `AnalyticsGraphQLModule` (`JsonScalar`, `DashboardResolver`, `MetricResolver`, `types.ts`), `MetricsController` (REST), `with-tenant-connection.ts`, `with-tenant-scoped-client.ts`, `analytics-app-replica-pool.provider.ts`, `source-view-registry.ts`, three new `DomainError` subclasses, one migration (`saved_report.name` + six seeded `MetricDefinition` rows).
- `TenantContextService`/`Middleware` widened with `actorId`/`requireActorId()` - additive, `requireTenantId()`'s own behavior unchanged.
- `DomainErrorFilter` gains the GraphQL-context bailout every other service's copy already has, now that a GraphQL context genuinely exists to bail out of. `HttpMetricsInterceptor` gains the multi-transport upgrade Phase 1's own doc comment predicted.
- Zero modification to any Module 02–08 table, migration, schema, or running code - this phase only reads `analytics_mv.mv_*`/`analytics.metric_definition` (both owned by this module already), never another module's schema directly.
- `docker-compose.yml`/`scripts/init-roles.sql`: no change - no new role, no new container (`agno_analytics_app`'s existing grants already cover this phase's reads/writes).

## Rollback plan

Revert `app.module.ts`'s `AnalyticsModule`/`AnalyticsGraphQLModule` imports, delete `src/analytics/`'s new files and `src/graphql/`, revert `TenantContextService`/`Middleware`/`DomainErrorFilter`/`HttpMetricsInterceptor` to their Phase 1–3 shape, run this phase's migration's own `down()` (drops the seeded metrics, drops `saved_report.name`), remove this doc and its checklist. Nothing outside this service depends on this phase's surface yet.

Verified against a real local Postgres, a real streaming replica (the same one Phase 2 stood up), and real GraphQL/REST requests, not just unit tests: `GET /v1/analytics/metrics/scheduled_hours?costCenter=CC-100` returns the real seeded value (26 hours) with a real `dataAsOf`; `metricQuery`/`executiveSummary` return correct, hand-verified figures via GraphQL; `createDashboard` → `dashboard(id)` → `myDashboards` round-trips correctly; a different actor genuinely cannot read another actor's dashboard (`DASHBOARD_NOT_FOUND`, not a 500 or a silent bypass); a different tenant genuinely cannot read across tenants (RLS, confirmed the same way); the expensive-metric guard was exercised directly by temporarily tiering a real metric and confirming rejection. 97 unit tests pass (up from 60 in Phase 3), lint/typecheck/build clean.

## Explicit assumptions (spec was ambiguous or silent here)

1. **`GET /v1/analytics/metrics/{metricName}` ships in Phase 4**, not deferred to Phase 6 - see Decision.
2. **`metricQuery`/the REST endpoint return a list of `MetricResult`, not a single value** - a dashboard widget wanting a trend/chart needs a series; a KPI-tile widget just uses the first item. `limit` defaults to 12, capped at 100.
3. **`executiveSummary`'s `period` argument is a server-resolved enum** (`CURRENT_MONTH`/`LAST_MONTH`/`LAST_QUARTER`), not a caller-supplied date range - §4.1 names the query as `executiveSummary(orgUnitId, period)` without specifying `period`'s shape.
4. **`executiveSummary` excludes `scheduled_hours`/`overtime_hours`/`approved_leave_days`** - see Problem's sixth item.
5. **`attrition_terminations`/`forecast_accuracy_mape` filtering by `orgUnitId` in `executiveSummary` is an exact match against `site_org_unit_id`/`org_unit_id`**, not an ancestor-aware resolution the way `mv_attrition_by_site`'s own refresh job resolves an employee's site. A business-unit-level `orgUnitId` that isn't itself the exact id on file returns no row for that metric, not a fabricated one.
6. **`myDashboards`/`getDashboard` authorize on `createdBy` only** - §2.3 rule 3's `sharedWith`/RBAC resolution is not implemented (see Decision).
7. **`MetricDefinition.category` for `attrition_terminations` is `'performance'`** - §2.1's fixed category enum has no clean fit for attrition; this is the least-bad choice, not a confident taxonomic claim.

## Out of scope for this phase (do not build yet)

- Module 01 RBAC/ABAC integration for `SavedReport.sharedWith` resolution (§2.3 rule 3) - no phase in this module's own §8 build-phase list currently owns this; flagged here as a real gap, not assigned to a specific later phase.
- `createScheduledExport` and the async export job itself - Phase 6.
- `askAnalyticsQuestion` - Phase 7.
- The custom-metric dry-run validation/cost-tiering pipeline for tenant-authored `MetricDefinition` rows (§0.5/§2.3 rule 2) - Phase 5. This phase's `estimated_cost_tier`/`validated_at` are set directly for its own six platform-authored rows, bypassing that pipeline by design (see the migration's own doc comment).
- The §0.5 load test, the consistency-check job - Phase 8.
