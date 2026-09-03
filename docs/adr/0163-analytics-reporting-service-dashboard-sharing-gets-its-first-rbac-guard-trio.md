# ADR-0163: analytics-reporting-service gets its first RBAC guard trio, closing the `sharedWith` gap Phase 4/7 both named but never resolved

## Context

`SavedReport.sharedWith` (jsonb, `DEFAULT '[]'`) has existed since §2.1's
original schema, and §2.3 rule 3 was explicit: "`sharedWith` is resolved
against Module 01's RBAC/ABAC on every access... a dashboard's sharing
settings should reflect current permissions, not a snapshot from when it
was created." Phase 4 shipped `createDashboard`/`getDashboard`/
`myDashboards` without implementing that resolution at all - `getDashboard`/
`listMyDashboards` authorized on `createdBy` only, `createDashboard` never
even accepted a way to populate `sharedWith`, and the module's own doc
comments named this a disclosed, deliberate gap (Phase 4 production
readiness checklist). It stayed that way through the frontend build
(`DashboardBuilderPage.tsx` shipped with no sharing UI and a note
explaining why) until being picked up as its own fix.

Unlike integration-hub-service (ADR-0145), ai-layer-service (ADR-0130), and
adherence-compliance-service (ADR-0161), analytics-reporting-service had
**no RBAC infrastructure of its own whatsoever** - every dashboard/metric
read and write was reachable by any caller holding a valid `X-Tenant-Id`
header, the same starting posture adherence-compliance-service had before
ADR-0161.

## Decision

**Copy the platform's established RBAC guard trio wholesale** - a new
`src/auth/` directory (`access-token.guard.ts`, `permissions.guard.ts`,
`tenant-token-match.guard.ts`, `require-permissions.decorator.ts`,
`current-token-claims.decorator.ts`, `auth.module.ts`), identical in shape
to the three prior copies. This service now depends on `jose` (`^5.10.0`,
matching the version every prior copy pins) for the first time.
`AccessTokenClaims` here additionally types `roles: string[]` (core's own
JWT claim, role *names* per `UserContextResolverService`) - the one field
none of the three prior copies needed, since this is the first RBAC-gated
service whose authorization logic reads the caller's roles rather than
just their flat permission list.

**One new permission resource, `dashboard`**, added to core's seed
(`src/database/seeds/run-seed.ts`'s `RESOURCES` array) -
`dashboard:read`/`dashboard:write` gate `dashboard`/`myDashboards`/
`createDashboard`/`updateDashboard` (`DashboardResolver`).
`MetricResolver`/`AnalyticsExportsController`/`MetricsController` are
**deliberately left ungated** - this ADR closes the specific `sharedWith`
finding, not every authorization question this module has; gating the
metric/export/BI-connector surface too would be a separate, larger
decision with its own permission design (see "Left untouched" below).

**`sharedWith` resolution: role-name intersection against a freshly
verified JWT, not a per-user list.** `DashboardService.isVisibleTo` grants
access when `dashboard.createdBy === actorId` OR the caller's *current*
`roles` claim intersects `dashboard.sharedWith`. This is the concrete
reading of "not a snapshot from when it was created": the JWT's `roles`
claim reflects a ≤720s-old fact (core's own access-token TTL, the same
staleness bound every other RBAC check in this platform already accepts),
so a user's access to a shared dashboard changes the moment their role
assignment does, with nothing on the dashboard row itself needing to be
touched. `createDashboard`/`updateDashboard` gained an optional
`sharedWithRoles: [String!]` input field to populate/replace it.
`updateDashboard` remains owner-only (`createdBy === actorId`) even for a
role-shared caller - sharing grants view access, not co-ownership; §2.3
rule 3 never asked for shared-editor semantics and this module has no
per-share permission level to store one in anyway.

**Actor identity moves off the `X-Actor-Id` header onto the verified JWT's
own `sub` claim**, for the four now-gated operations only. `sharedWith`
resolution needs a `roles` claim no header could ever carry, and once a
real bearer token is being verified anyway, trusting its `sub` over a
same-request, unverified header closes a spoofing gap for free rather than
leaving two different actor-identity sources active side by side for the
same four operations.

**`DashboardResult` gained two fields** (`createdBy`, `sharedWith`) so the
frontend can compute "am I the owner" (compare `createdBy` against its own
verified `sub`) and render current sharing state, without a server-trusted
boolean computed from a header.

**Left untouched, deliberately:**
- `MetricResolver` (`metricQuery`/`executiveSummary`/`metricDefinitions`/
  `createMetricDefinition`/`askAnalyticsQuestion`), `AnalyticsExportsController`,
  `MetricsController` (the REST BI-connector surface) - none of these had
  a `sharedWith`-shaped gap to close; gating them is a separate, larger
  RBAC-surface decision this ADR does not make.
- Listing every *user* a dashboard is shared with, or an org-unit-scoped
  ABAC dimension - §2.3 rule 3 says "RBAC/ABAC" but the concrete UI ask
  (`DashboardBuilderPage.tsx`'s own "shared_with UI") is a sharing list;
  role-name sharing is the smallest concrete mechanism that satisfies
  "resolved against live... not a snapshot," reusing infrastructure
  (the JWT `roles` claim) that already exists platform-wide, rather than a
  new per-user ACL table or a gRPC client to core's `IdentityService` for
  per-request org-unit-scope resolution.

## Consequences

- Verified with a real end-to-end guard test (`test/integration/rbac.spec.ts`,
  own copy of adherence-compliance-service's identical test): a real local
  JWKS server, real signed RS256 JWTs (now including a `roles` claim), and
  the actual guard classes `DashboardResolver` uses.
- Verified live against the actually-running local dev database
  (`createDashboard`/`updateDashboard`/`myDashboards` exercised via real
  GraphQL calls) - this caught a real bug the unit tests' mocked
  `EntityManager` could not: `agno_analytics_app` never had `DELETE`
  granted on `analytics.dashboard_widget` (only `SELECT, INSERT, UPDATE`,
  `InitialAnalyticsSchema`'s original grant), so `updateDashboard`'s
  replace-widgets step failed with `permission denied for table
  dashboard_widget` on first live exercise. Fixed by a small prior
  migration (`GrantDashboardWidgetDelete`), unrelated to this ADR's own
  RBAC scope but a precondition for it working at all.
- `tsc --noEmit`, `eslint`, and the full 157-test unit suite all pass
  unchanged - no existing test exercised `DashboardResolver`'s four
  operations through the GraphQL layer `@UseGuards` enforces (all existing
  coverage called `DashboardService` directly), so nothing broke; that same
  layer is exactly what the new unit tests for `isVisibleTo` and the
  integration test for the guard trio itself now cover.
- `analytics_rbac_denials_total` (labeled `reason`, same shape as every
  other RBAC-gated service's identical metric) is this module's first RBAC
  observability signal.
- The frontend (`web-console`) gained a "share with roles" picker in
  `DashboardBuilderPage.tsx`, sourced from core's real `/v1/roles` list (no
  new frontend service dependency - that endpoint already existed for the
  Roles & Permissions admin page), and the `/analytics/dashboards` nav
  entry moved from `requiredPermission: null` to `'dashboard:read'`, the
  first real permission gate anywhere in this phase.
