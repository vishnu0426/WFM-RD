# Module 12 Phase 3 Design Doc — Integration Hub: First HRIS Connector, Full Batch Sync Path

**Status:** Approved for implementation
**Owner:** Integration Hub pod (Module 12).
**Scope:** Per §7 — "One real provider adapter end to end: field mapping, dry-run against Module 02's bulk-import, then live sync - validates the batch pattern before building N more batch adapters." Concretely: `FieldMappingsService` + GraphQL `updateFieldMapping` (a real upsert), `syncJobHistory` GraphQL query (needed to observe this phase's own real sync outcomes), `BulkImportClientService` (a real HTTP client against Module 02's real, already-built `POST /v1/employees/bulk-import`), and `WorkdayAdapter` — the first registered `BatchConnectorAdapter`, replacing Phase 2's empty adapter registry with exactly one real entry.

## Problem

Three real gaps needed resolving, none obvious from the module prompt alone:

1. **This environment has no real, credentialed Workday tenant to call.** Consistent with how Phase 2 handled the identical problem for OAuth (a real generic token-endpoint test double, ADR-0137), `WorkdayAdapter` is real, protocol-shaped HTTP client code verified against a real local HTTP server standing in for Workday's actual REST API surface — not a mock of the adapter's own internals. What's genuinely different from Phase 2's approach: the *other* leg of this phase's real work — Module 02's bulk-import — **does exist in this monorepo already, fully built**, so this phase's verification runs the adapter against a real fake Workday leg and a 100%-real Module 02 leg simultaneously, which is a stronger verification than Phase 2 could get for either of its two external legs.
2. **`FieldMapping` (§2.1) has no identifier-crosswalk mechanism** — it renames a field and can transform its *value* (enum translation, unit conversion), but has no lookup-table concept for translating a source system's own identifier (e.g. Workday's organization code) into Agno's UUID space. Resolved as a real, disclosed gap in ADR-0138, not silently worked around.
3. **`IntegrationConnector.config` needed a real extension point for non-secret, provider-specific operational settings** (`workdayApiBaseUrl`) beyond the credential-reference/OAuth fields Phase 2 already put there — §2.1 already scoped `config` to include "field mapping refs, sync schedule" alongside the credential reference, so this is squarely inside the column's own stated purpose, not scope creep. `CreateConnectorInput.additionalConfig` (merged into `config` after credential extraction, still run through the credential-shape guard) is the generic extension point every future adapter's own settings will use too.

## Decision

**`FieldMappingsService.upsert`** (`src/connectors/field-mappings.service.ts`) — keyed by the `(connector_id, source_field)` unique constraint from Phase 1's own migration, since §3.1 names only `updateFieldMapping`, no separate create mutation. Rejects a non-null `authority` for an `acd` connector (§2.2 rule 5), structurally, at the point of write — not left as a documented-but-unenforced rule.

**`BulkImportClientService`** (`src/sync/batch/providers/bulk-import-client.service.ts`) — a real HTTP client against Module 02's real `POST /v1/employees/bulk-import` / `GET /v1/jobs/:id` (verified live to require only an `X-Tenant-Id` header, no bearer token — this is Module 02's own current, documented-as-ungated trust model for this endpoint, not something this module weakens). Polls the async job to a terminal status with a bounded budget (`BulkImportJobTimeoutError` on exhaustion), since Module 02's own docs disclose this endpoint has no durable job queue.

**`WorkdayAdapter`** (`src/sync/batch/providers/workday.adapter.ts`) — the first real `BatchConnectorAdapter`. Fetches raw worker records from `config.workdayApiBaseUrl`, applies every `FieldMapping` row for the connector (`applyFieldMappings`, `src/sync/batch/providers/field-mapping-transform.ts` — `valueMap` and `multiply` transform shapes, the two Phase 3 actually needs), drops any record left incomplete after mapping (never sent to Module 02), then runs §2.2 rule 3a's dry-run-then-commit sequence via `BulkImportClientService`. A commit blocked by Module 02's own `bulk_import_destructive` tenant feature flag is reported as `partial_failure` with both the dry-run and commit outcomes preserved in `errorDetails` — a real, expected outcome, not a bug.

**`BatchSyncRunnerService` fix** (Phase 2 code, fixed this phase): `findDueConnectors`'s raw SQL and `triggerManualSync`'s connector lookup both now carry the connector's real `config` through to `adapter.sync()`, replacing a hand-picked `{id, tenantId, provider, connectorType}` projection that silently dropped it. See Verification — this was Phase 2 code with a real, live bug invisible until Phase 3's first adapter actually needed the field it was missing.

## Verification

**Setup for this run** (documented so a future run can reproduce it): the already-seeded "Acme Demo Corp" tenant (`npm run seed` at repo root, idempotent) provided a real tenant id and a real `site`-type org unit id. `bulk_import_destructive` was enabled for that tenant directly via SQL against `org.feature_flags` (`INSERT ... ON CONFLICT (tenant_id, flag_key) DO UPDATE SET enabled = true`) so this phase's verification could exercise the real committed-write path, not just the dry-run half.

**Service-level, real Postgres + real Vault + real fake-Workday HTTP server + REAL Module 02** (`test/integration/workday-adapter.spec.ts`): a real local HTTP server stands in for Workday's `/workers` endpoint (Bearer-auth-checked), returning two complete worker records and one deliberately incomplete one (no org identifier). `WorkdayAdapter.sync()` is exercised directly against real `VaultClientService`/`FieldMappingsService`/`BulkImportClientService` instances, itself calling the **actual running root service** (`platform-core`, Module 01+02) on its real port. Asserts `partial_failure` (the incomplete record correctly drops out, `recordsFailed: 1`) and — the real proof — queries `org.employees` directly afterward and finds the two complete records landed with the correctly field-mapped/transformed values (`employment_type: 'full_time'`/`'part_time'`, `contract_hours_per_week: 40`/`20` from the FTE-fraction `multiply` transform, the real `org_unit_id`).

**Full live HTTP pass against the actually-running, NestJS-DI-assembled app** (not a Jest suite — the same posture Phase 2 used, which is what caught Phase 2's three real bugs): `createConnector` (GraphQL) → five `updateFieldMapping` calls (GraphQL) → `POST /v1/integrations/connectors/{id}/sync` (REST) → `syncJobHistory` (GraphQL) → a direct `psql` check of `org.employees`. This pass is what caught the real bug below — a manually-constructed `WorkdayAdapter` in a Jest test (which loads the connector via `IntegrationConnectorsService.findByIdForTenant`, always fetching the real, full row) could never have surfaced it.

**One real bug this live pass caught, fixed in this phase**: `BatchSyncRunnerService` (Phase 2 code) never carried `IntegrationConnector.config` through to `adapter.sync()` — `findDueConnectors`'s raw SQL selected only `id`/`tenant_id`/`provider`/`connector_type`, and `triggerManualSync` (despite loading the *full* entity) still hand-picked the same four fields before calling `runOne`. Invisible throughout Phase 2 because the empty adapter registry meant nothing ever read `config`. Surfaced immediately and clearly the first time a real adapter tried: `Cannot read properties of undefined (reading 'workdayApiBaseUrl')`. Fixed by having both call sites carry the real, full `IntegrationConnector` (config included) through to `adapter.sync()` — see the file's own updated doc comment.

**Full suite**: 33 unit tests (up from 25; `field-mapping-transform.spec.ts` covers `valueMap`/`multiply`/dot-path extraction/unmapped-field-dropping) + 25 integration tests (up from 24; the new `workday-adapter.spec.ts` plus the existing suites re-verified clean), `npm run typecheck`/`npm run lint` both clean.

**Cleanup**: all test-created connectors/field-mappings/sync-jobs and the two real `org.employees` rows created by the live-HTTP pass were deleted after verification; the seeded `bulk_import_destructive` flag was left enabled for "Acme Demo Corp" (a real, intentional tenant-level setting, not test pollution — future phases' own verification against the same seed tenant benefit from it already being on).

## Blast radius

- New code entirely within `integration-hub-service/`: `src/connectors/field-mappings.service.ts`, `src/connectors/graphql/field-mapping.resolver.ts`, `src/connectors/graphql/sync-job-history.resolver.ts`, `src/sync/batch/providers/*`. One new ADR (0138) and this doc.
- Two Phase 2 files modified: `batch-sync-runner.service.ts` (the real config-passthrough bug fix above) and `integration-connectors.service.ts`/`integration-connector.resolver.ts` (the `additionalConfig` extension point).
- No schema/migration change - `IntegrationConnector.config`/`FieldMapping.transformation_rule` were already jsonb with no fixed shape.
- Zero modification to Module 02 (`src/`) or any other service - this module only ever calls Module 02's already-existing, already-public REST contract.

## Rollback plan

Revert this phase's commits. Phase 2's connector framework, OAuth flow, and empty-registry batch/streaming bases are untouched and still function on their own (an HRIS connector created before this phase's revert would simply have no adapter registered again, the same clean `no_adapter_registered` outcome Phase 2 already proved).

## Explicit assumptions (spec was ambiguous or silent here)

1. **No identifier-crosswalk mechanism for `FieldMapping`** — ADR-0138, a real, disclosed limitation affecting every future batch adapter's org/department/cost-center identifiers, not just Workday's.
2. **Dry-run runs on every sync, not just "first sync or after a FieldMapping change."** §2.2 rule 3a names both triggers; detecting "has the mapping changed since the last live sync" needs a cursor/hash this module doesn't have yet (nothing in `FieldMapping`/`SyncJob` tracks "which mapping version produced which sync"). Running dry-run unconditionally is strictly safer than the alternative (skipping it) and costs one extra Module 02 round trip per sync - a real, bounded cost, not free, but the correct default until a real change-detection mechanism is built.
3. **A commit blocked by Module 02's `bulk_import_destructive` flag is `partial_failure`, not `failed`.** The dry-run half genuinely succeeded (real, useful information - "here's what would happen"); only the commit half was blocked, and by Module 02's own deliberate safety gate, not an error condition. Collapsing this into a bare `failed` status would make a legitimate, expected first-sync-before-opt-in outcome indistinguishable from a real integration failure.
4. **`workdayApiBaseUrl` lives in `config` via the new generic `additionalConfig` extension point, not a Workday-specific column.** Every future batch adapter will need its own non-secret settings in `config`; a single generic mechanism (still guarded by the credential-shape check) avoids a schema/API change per provider.

## Out of scope for this phase (do not build yet)

- `FieldAuthorityPolicy` CRUD, conflict detection/resolution, the identifier-crosswalk mechanism ADR-0138 flags - Phase 4.
- Real per-provider rate-limit enforcement (§5a) - Phase 5.
- Any ACD/streaming adapter, the identical "real adapter, real verification against a real fake provider server" pattern applied to `StreamingRelayAdapter` - Phase 6.
- Remaining batch adapters (SAP SuccessFactors, ADP, Salesforce) reusing this phase's now-proven pattern - Phase 6b.
- `WebhookSubscription`/`WebhookDelivery`, the outbound dispatcher - Phase 7.
- Connector health dashboard, remaining GraphQL surface, dashboards/runbooks - Phase 8.
