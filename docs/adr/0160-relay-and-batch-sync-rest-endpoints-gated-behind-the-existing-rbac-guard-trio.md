# ADR-0160: `RelayController`/`BatchSyncController`'s REST endpoints gated behind the existing RBAC guard trio, closing this module's highest-risk unauthenticated surface

## Context

ADR-0145 (Phase 8) gave this service a real RBAC guard trio
(`AccessTokenGuard`/`PermissionsGuard`/`TenantTokenMatchGuard`, remote-JWKS
JWT verification against core) and applied it to exactly two GraphQL
mutations - `createConnector` and `createWebhookSubscription` - framed at
the time as "the two highest-credential-risk writes in this module's
schema." The Phase 8 readiness checklist named the resulting gap
honestly: "RBAC gates only two mutations... every other query/mutation in
this module's schema remains on the `x-tenant-id` header-trust
placeholder... expanding further is a real, explicit scope decision for a
future phase."

What that framing missed - because it was scoped to the GraphQL schema -
is that this module's actual highest-risk surface isn't GraphQL at all.
`RelayController`'s `POST :id/relay/start` opens a **live outbound
OAuth/WebSocket session to a real external ACD provider** using the
connector's own Vault-referenced credential (`StreamingRelayService.start`);
`relay/stop` and `relay/status` operate and read that same live session;
`BatchSyncController`'s `POST :id/sync` runs a **real batch sync against a
real HRIS/payroll/CRM** using the same class of credential. All four had
**zero guards of any kind** - not even the `x-tenant-id` header-trust
baseline the rest of the unguarded GraphQL schema at least nominally
relies on for tenant scoping; these four REST endpoints only trusted
whatever the middleware-derived tenant context happened to be. Anyone who
could reach this service and set `X-Tenant-Id` to a real tenant could open
or close that tenant's live ACD session, or trigger a real sync against
their real HRIS, with no credential of their own.

## Decision

**Gate all four endpoints with the exact same guard trio and pattern
`createConnector`/`createWebhookSubscription` already use** -
`@UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)`,
consistent with this module's one established RBAC precedent rather than
inventing a second pattern for REST vs. GraphQL.

**Permission strings reuse the already-seeded `integration_connector`
resource** (`src/database/seeds/run-seed.ts`'s `RESOURCES` array seeds
every `PermissionAction` per resource, so `integration_connector:read`
already existed, grantable, just never checked by anything):
- `relay/start`, `relay/stop`, `:id/sync` → `integration_connector:write`
  - the same risk tier as `createConnector` itself: all four operate a
    connector's own credential, not just read connector metadata.
- `relay/status` → `integration_connector:read` - the first thing in this
  module to ever check it.

No new permission strings, no new seed migration - whoever already holds
`integration_connector:write` (i.e., whoever can create a connector) can
now also operate it, which is the correct default: creating a connector
with no way to ever run or relay it would be a strange split.

**`SyncModule` now imports `AuthModule`** (previously imported nowhere
outside `IntegrationHubGraphQLModule`/`WebhooksModule`) so the three guard
classes resolve in this module's own DI scope.

## Consequences

- Verified: `tsc --noEmit`, `eslint`, and this service's existing 61-test
  unit suite (unaffected - `test/integration/sync-module.spec.ts` calls
  `StreamingRelayService`/`BatchSyncRunnerService` directly, never through
  the HTTP layer `@UseGuards` enforces) all pass unchanged.
  `test/integration/rbac.spec.ts`'s existing guard-trio test already
  proves `AccessTokenGuard`/`PermissionsGuard`/`TenantTokenMatchGuard`
  against a real JWKS server and real signed JWTs (using
  `integration_connector:write` as its own example permission) - these
  four endpoints now go through those exact same, already-proven guard
  classes, not a new implementation; `PermissionsGuard`'s string-matching
  logic doesn't distinguish `:read` from `:write` specially, so no
  additional guard-level proof is needed for the one new permission string
  (`integration_connector:read`) this ADR is the first to actually check.
- The Phase 8 checklist's "RBAC gates only two mutations" item is updated,
  not deleted - the rest of the GraphQL schema (`connectors` query,
  `connectorHealth`, field-mapping/authority-policy CRUD) is still on the
  header-trust placeholder. This ADR closed the specific gap that had the
  worst blast radius (a live external session / a real HRIS sync with a
  real credential), not RBAC coverage in general - that remains a real,
  explicit scope decision for whichever future phase takes it on.
