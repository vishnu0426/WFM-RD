# ADR-0164: analytics-reporting-service's RBAC extended from dashboards to the rest of Module 09's surface

## Context

ADR-0163 gave `analytics-reporting-service` its first RBAC infrastructure,
but scoped it deliberately narrow - only `DashboardResolver`'s four
operations (`dashboard`/`myDashboards`/`createDashboard`/`updateDashboard`),
because those were the only ones with a `sharedWith` gap to close.
`MetricResolver` (`metricQuery`/`executiveSummary`/`metricDefinitions`/
`createMetricDefinition`/`askAnalyticsQuestion`), `AnalyticsExportsController`
(`POST`/`GET /v1/analytics/exports`, download), and `MetricsController`
(the REST BI-connector endpoint) all stayed on the original header-trust
placeholder (ADR-0014) - reachable by any caller holding a valid
`X-Tenant-Id` header, no permission required.

Left that way, this is a real gap beyond just "inconsistent with
dashboards": the BI-connector endpoint in particular is meant to back a
long-lived external credential (a Tableau/PowerBI connection string), and
shipping that with no authentication at all is a materially different risk
than an internal admin page being briefly ungated.

## Decision

**Two new permission resources**, `metric_definition` and `analytics_export`,
added to core's seed (`RESOURCES` array) alongside `dashboard`.

**Permission mapping:**
- `metric_definition:read` - `metricQuery`, `executiveSummary`,
  `metricDefinitions`, `askAnalyticsQuestion` (GraphQL), and
  `GET /v1/analytics/metrics/{metricName}` (REST BI connector).
  `askAnalyticsQuestion` is grouped here rather than getting its own
  resource - it has no persisted state of its own to protect, it only ever
  executes the same `metricQuery`/`executiveSummary` read path the other
  gated reads already use.
- `metric_definition:write` - `createMetricDefinition`.
- `analytics_export:read` - `GET /v1/analytics/exports` (list),
  `GET /v1/analytics/exports/{id}` (poll), `GET .../{id}/download`.
- `analytics_export:write` - `POST /v1/analytics/exports`.

**Actor identity for `AnalyticsExportsController` moves off `X-Actor-Id`
onto the verified JWT's `sub` claim** (`@CurrentTokenClaims()`), the same
change ADR-0163 made for `DashboardResolver` - `getExport`/`getDownloadUrl`/
`listExports` all scope to `requestedBy === actorId`, so trusting the
verified claim over an unverified header closes the same spoofing gap.

**`CurrentTokenClaims` widened to work over REST, not just GraphQL** - its
original ADR-0163 implementation only ever handled a GraphQL execution
context (`GqlExecutionContext.create(context).getContext()`), because
`DashboardResolver` was its only caller. Applied to
`AnalyticsExportsController`'s plain HTTP requests, that same
implementation would have thrown or read the wrong thing - caught before
shipping, not live. Fixed with the identical GraphQL-vs-HTTP branch
`AccessTokenGuard`'s own `getRequest` helper already uses.

## Blast radius

- `AnalyticsModule` now imports `AuthModule` and re-lists
  `AccessTokenGuard`/`PermissionsGuard`/`TenantTokenMatchGuard` in its own
  `providers` (the same DI quirk ADR-0163 already documents - a guard
  referenced via `@UseGuards(...)` resolves through the *consuming*
  module's own injector). `MetricsModule`/`TenantContextModule` were
  already imported there for unrelated reasons, which happens to be
  exactly what those guards' own constructor dependencies needed visible
  in this module's context too - no additional module wiring required
  beyond `AuthModule` itself.
- `web-console`'s `/analytics/metrics/custom`, `/analytics/exports`,
  `/analytics/ask` nav entries moved from `requiredPermission: null` to
  real permissions (`metric_definition:read` / `analytics_export:read`).

## Consequences

- Verified live against the actually-running dev database with a real
  OAuth-issued token: unauthenticated requests to all three surfaces now
  correctly `401`; an authenticated `tenant_admin` token succeeds, and
  `AnalyticsExport.requestedBy` now correctly reflects the token's real
  `sub` rather than a caller-supplied header.
- `tsc --noEmit`, and the full 157-test unit suite pass unchanged - no
  existing unit test exercises these controllers/resolvers through the
  HTTP/GraphQL layer `@UseGuards` enforces (all existing coverage calls the
  underlying services directly).
- The BI-connector endpoint (`GET /v1/analytics/metrics/{metricName}`) can
  now back a real, narrowly-scoped connector credential rather than being
  the one fully-open surface in this module.
