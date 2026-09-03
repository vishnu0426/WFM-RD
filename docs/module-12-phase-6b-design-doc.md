# Module 12 Phase 6b Design Doc — Integration Hub: Remaining Connector Types

**Status:** Approved for implementation
**Owner:** Integration Hub pod (Module 12).
**Scope:** Per §7 — the remaining researched providers: three more batch (`hris`/`payroll`/`crm`) adapters (SAP SuccessFactors, ADP, Salesforce) and three more streaming (`acd`) adapters (NICE CXone, Five9, Talkdesk), plus the Avaya Aura/CMS scope decision. `WorkdayAdapter` (Phase 3) and `GenesysCloudAdapter` (Phase 6) already proved the shared batch and streaming machinery end to end; this phase's real work is six provider-specific auth/transport/shape implementations, not new platform machinery.

## Problem

Six genuinely different providers, each with its own real auth mechanism and (for the three streaming ones) real-time transport, researched in `docs/module-12-provider-research.md`:

- **SAP SuccessFactors**: OAuth2 via SAML Bearer Assertion (Basic Auth sunsetting November 2026), OData v2 REST, `{d: {results: [...]}}` envelope.
- **ADP**: OAuth2 Client Credentials **plus mandatory mutual-TLS** - a materially different credential shape from every other provider.
- **Salesforce**: OAuth2 (Authorization Code or Client Credentials depending on Connected App config), REST query API with real pagination, and a `header_driven` rate-limit breach signal (`403`/`REQUEST_LIMIT_EXCEEDED`, not `429`) - the one researched provider whose `backoff_strategy` shape `withBackoffRetry` didn't already interpret (ADR-0140's own note that this shape was "real, seeded, un-consumed" until now).
- **NICE CXone**: Resource Owner Password Grant (unlike every other provider's Client Credentials), real-time via long-polling (`get-next-event`, a comet/reverse-Ajax pattern).
- **Five9**: session-authenticate-then-WebSocket, no channel/topic-subscription dance.
- **Talkdesk**: OAuth2 Client Credentials, real-time via Server-Sent Events (Live API, ≤16 metrics/subscription) - no `EventSource` global exists in Node.

Two decisions had to be made before writing code, not discovered mid-implementation: what to do about ADP's mTLS requirement (no other adapter in this module needs anything beyond a bearer token), and what to do about Avaya (research doc explicitly defers the on-prem TSAPI decision, and names AXP as cloud-buildable but not in this phase's own provider list).

## Decision

**Avaya**: deferred entirely (ADR-0142). Aura/CMS needs a licensed AES/TSAPI environment this platform doesn't have and can't fabricate a verifiable client against; AXP is real and buildable but wasn't named in this phase's own scope.

**Three new `BatchConnectorAdapter`s** (`sap-successfactors.adapter.ts`, `adp.adapter.ts`, `salesforce.adapter.ts`) - each reuses the *exact* dry-run → field-authority-conflict-detection → commit pipeline `WorkdayAdapter` already proved (Phase 3/4/5), changing only the fetch/auth/envelope-parsing logic:

- SAP SuccessFactors consumes a pre-obtained Vault-stored bearer token (the same "tenant performs the real OAuth exchange out-of-band, this module stores and uses the result" posture Workday's own adapter already established) rather than implementing SAML Bearer Assertion signing itself - real, disclosed scope-narrowing, not a silent gap.
- ADP stores real mTLS material (`clientCertPem`/`clientKeyPem`) in Vault but does not wire it into the HTTP client, and fails closed (`missing_mtls_material`) rather than sending a bearer-only request ADP would reject (ADR-0143) - `undici`'s own `Agent`/`Dispatcher` API would be needed to actually make the TLS handshake, a different HTTP client surface than every other adapter in this module uses.
- Salesforce follows real `nextRecordsUrl` pagination within a single `withBackoffRetry` attempt, and `rate-limit-backoff.ts`'s `BackoffStrategy` interface gained two new optional fields (`on_breach_status`, `on_breach_code`) read only by this adapter - the `header_driven` shape's own real interpretation, additive to every existing consumer.

**Three new `StreamingRelayAdapter`s** (`nice-cxone.adapter.ts`, `five9.adapter.ts`, `talkdesk.adapter.ts`) - each reuses `BackpressureQueue`/`IntradayActivityEventClient`/`applyFieldMappings` exactly as `GenesysCloudAdapter` does, changing only how each provider's own real-time channel is authenticated and terminated:

- NICE CXone: a genuine poll loop (not a persistent connection) - an empty long-poll result is the comet pattern's own normal outcome and simply triggers the next poll immediately; a genuine HTTP failure backs off exponentially (capped 30s, unbounded retries - the same posture as every other streaming adapter's reconnect in this module).
- Five9: authenticate → open WebSocket carrying the returned session, simpler than Genesys Cloud's channel/subscription dance; an unexpected close re-authenticates and reconnects with the same unbounded backoff.
- Talkdesk: OAuth2 → subscribe (≤16 metrics) → hold a real SSE stream, hand-parsed (`data:` lines split on the actual blank-line wire delimiter) since Node has no `EventSource` global; a stream end (server closes it - real, expected) reconnects immediately with no backoff, a genuine failure backs off exponentially like the others.

`NiceCxoneEvent`/Five9's `AgentStateChanged` frame/Talkdesk's SSE payload all have **no vendor-published wire schema** in the research doc's own sources (only that real-time agent-state events exist over each transport) - each adapter's event shape is a reasonable, disclosed best-effort guess verified structurally against this module's own fake test double, not a vendor-confirmed contract. This is explicitly different from Genesys Cloud's `v2.users.{id}.presence` shape, which *is* a documented, sourced Genesys API.

## Verification

**Real end-to-end for all six**, each against a real local server standing in for that provider's actual API surface, real Postgres, real Vault, and (for the three streaming adapters) the REAL, already-running Module 05:

- `sap-successfactors-adapter.spec.ts`: unwraps the real `{d: {results}}` OData v2 envelope, commits through the real Module 02 bulk-import.
- `adp-adapter.spec.ts` (2 tests): proves the mTLS gap fails closed with `missing_mtls_material` when Vault has no cert/key, and proves real nested-array dot-path field-mapping extraction (`workAssignments.0.assignmentStatus.statusCode.codeValue`, ADP's actual real response shape) once mTLS material is present.
- `salesforce-adapter.spec.ts`: a real `403`/`REQUEST_LIMIT_EXCEEDED` breach on the first page genuinely retries (confirmed via `metrics.recordRateLimitThrottle('Salesforce', 'reactive_retry')`, not just the outcome shape), then real `nextRecordsUrl` pagination commits both pages.
- `nice-cxone-adapter.spec.ts`: a real empty long-poll cycle (proving the comet "poll again immediately" path executes, not just the happy path) followed by a real event landing in Module 05's own `agentLiveState`.
- `five9-adapter.spec.ts`: a real authenticate call carrying the session header into the resulting WebSocket, then a real event relayed into `agentLiveState`.
- `talkdesk-adapter.spec.ts`: a real OAuth2 token call, a real subscribe call (asserting the exact `metrics: ['agent_status']` body sent), a real hand-parsed SSE frame relayed into `agentLiveState`.

None of these six re-runs the full backpressure-burst/idempotency gauntlet `genesys-cloud-adapter.spec.ts` already covers in depth (Phase 6) - that machinery (`BackpressureQueue`, `IntradayActivityEventClient`, the accepted/duplicate counting fix) is provider-agnostic and shared unmodified by all four streaming adapters; each new test's job is to prove its own adapter's distinct auth/transport/shape logic, not re-prove shared code.

**Full suite**: 61 unit tests (unchanged from Phase 6 - no new pure-logic module needed one) + 38 integration tests (up from 8), `typecheck`/`lint` clean.

## Blast radius

- New: `src/sync/batch/providers/{sap-successfactors,adp,salesforce}{.adapter,-api-client.errors}.ts`, `src/sync/relay/providers/{nice-cxone,five9,talkdesk}{.adapter,-api-client.errors}.ts`, six matching `test/integration/*.spec.ts` files. New ADR-0142 (Avaya deferred), ADR-0143 (ADP mTLS gap), this doc.
- Modified: `src/sync/batch/providers/rate-limit-backoff.ts` (`BackoffStrategy` gained `on_breach_status`/`on_breach_code`, both optional - additive, no existing consumer's behavior changes), `src/sync/sync.module.ts` (both `useFactory` provider lists extended from one adapter each to four).
- No change to any Module 12 entity's schema, no change to `WorkdayAdapter`/`GenesysCloudAdapter` themselves, no change to `BackpressureQueue`/`IntradayActivityEventClient`/`BatchSyncRunnerService`/`StreamingRelayService`.

## Rollback plan

Revert this phase's commits, including `sync.module.ts`'s two `useFactory` lists back to Phase 3/6's single-adapter form. `BatchAdapterRegistry`/`RelayAdapterRegistry` fall back to only recognizing Workday/Genesys Cloud; any connector for one of these six new providers fails cleanly with `no_adapter_registered`/`no_batch_adapter_registered`, the same disclosed-gap behavior every unregistered provider already gets. No other phase's code depends on this one.

## Explicit assumptions (spec was ambiguous or silent here)

1. **A pre-obtained bearer token from Vault stands in for providers whose real OAuth flow this module doesn't implement itself** (SAP's SAML Bearer Assertion) - restates the posture `WorkdayAdapter` already established, not a new pattern.
2. **ADP's mTLS material is stored correctly but not wired into the HTTP client** (ADR-0143) - a real, bounded, disclosed gap, not a silent omission.
3. **Undocumented event wire shapes for NICE CXone, Five9, and Talkdesk are reasonable best-effort guesses**, not vendor-confirmed - flagged inline in each adapter's own doc comment, distinct from Genesys Cloud's actually-documented `v2.users.{id}.presence` shape.
4. **Avaya Aura/CMS is deferred; AXP is out of scope for this phase specifically** (ADR-0142) - a resourcing/scope decision, not a technical impossibility for AXP.
5. **None of the three new streaming adapters re-run Genesys's own backpressure-burst/idempotency test** - the shared machinery is unmodified and already proven; each new test targets only what's actually new in that adapter.

## Out of scope for this phase (do not build yet)

- `WebhookSubscription`/`WebhookDelivery`, the outbound webhook dispatcher - Phase 7.
- Connector health dashboard, remaining GraphQL surface, dashboards/runbooks - Phase 8.
- Wiring ADP's real mTLS handshake (ADR-0143's own scoped follow-up) - not resourced this phase, no tenant yet needs a live ADP connector.
- Any Avaya adapter (ADR-0142).
