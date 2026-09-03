# ADR-0166: integration-hub-service RBAC extended to the rest of its GraphQL surface

## Context

Frontend Phase 8 (`/admin/connectors`, `/admin/connectors/[id]/field-mappings`, `/admin/webhooks`) needs to build against Module 12's GraphQL schema. ADR-0145 gated exactly two mutations — `createConnector` and `createWebhookSubscription` — on the stated reasoning "gate the specific escalating risk, not everything at once," and `IntegrationHubGraphQLModule`'s own doc comment disclosed the rest of the schema as still running on the header-trust placeholder (ADR-0014). That remainder is large: `connectors` (list), `syncJobHistory`, `triggerManualSync`, `updateFieldMapping`, `fieldAuthorityPolicies`, `createFieldAuthorityPolicy`, `connectorHealth`/`connectorsHealth`, `webhookSubscriptions`, `testWebhook`, `webhookDeliveries` — reads of connector/webhook configuration and real writes (`triggerManualSync` starts a real sync job; `updateFieldMapping`/`createFieldAuthorityPolicy` change how external HRIS/payroll/ACD data is trusted against Agno's own) with zero permission check, gated only by `X-Tenant-Id` header trust.

Phase 8's own framing (elevated security scrutiny, "a UI that echoes a secret back... undermines the entire backend design," explicit refusal to build a frontend on top of `configureAiProvider`'s then-believed-open RBAC gap) applies identically here — building `/admin/connectors` and `/admin/webhooks` against this surface as-is would make an existing, undisclosed-to-the-frontend-spec hole easier to reach, not just fail to help.

## Decision

Extend the exact guard trio already proven in this service (`AccessTokenGuard` + `PermissionsGuard` + `TenantTokenMatchGuard`, ADR-0145) to every remaining query/mutation, reusing the two resources ADR-0145 already seeded rather than inventing new ones — a field mapping and a field authority policy are both connector sub-resources, not independent concerns:

- `integration_connector:read` — `connectors`, `syncJobHistory`, `fieldAuthorityPolicies`, `connectorHealth`, `connectorsHealth`
- `integration_connector:write` — `triggerManualSync` (same permission `POST /v1/integrations/connectors/{id}/sync`, unchanged, already required — this mutation calls the identical `BatchSyncRunnerService.triggerManualSync`), `updateFieldMapping`, `createFieldAuthorityPolicy`
- `webhook_subscription:read` — `webhookSubscriptions`, `webhookDeliveries`
- `webhook_subscription:write` — `testWebhook` (a real, dispatcher-queued delivery attempt, not a pure read)

No new `RESOURCES` entries needed — `integration_connector`/`webhook_subscription` already exist (ADR-0145's own seed). `IntegrationHubGraphQLModule`/`WebhooksModule` already re-list the guard classes in their own `providers` (the DI quirk this platform has hit repeatedly — a guard resolves through the *consuming* module's injector — was already handled when ADR-0145 landed), so this change is purely additive decorators on existing resolver methods, no module-wiring change needed.

## Consequences

- No query or mutation in `integration-hub-service`'s GraphQL schema is left on the header-trust placeholder. Frontend Phase 8's connector/field-mapping/webhook pages can be built against this schema without reproducing the `configureAiProvider` antipattern the phase's own spec warns against.
- Live-verified: an unauthenticated `connectors`/`webhookSubscriptions` query now returns `401 UNAUTHENTICATED` (previously would have returned real tenant data with only an `X-Tenant-Id` header). Full unit suite (68/68) and the existing `rbac.spec.ts` integration test (7/7, guard-class-level, unaffected by this purely-declarative change) re-run clean; `tsc -b`/lint clean. All 12 services restarted and verified healthy.
- `BatchSyncController`'s REST `POST /v1/integrations/connectors/{id}/sync` and `RelayController`'s REST endpoints were already gated identically before this change — this ADR brings the GraphQL surface to parity with REST, not ahead of it.
