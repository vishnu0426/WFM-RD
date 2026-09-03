# ADR-0143: `AdpAdapter` stores mTLS client-certificate material in Vault but does not wire it into the HTTP client

## Context

`docs/module-12-provider-research.md`'s ADP section: "Mutual TLS is required in addition to the bearer token - a client cert from ADP's Partner Self-Service Portal, valid 2 years, is a hard prerequisite for every call. This is a materially different credential shape from the other batch providers." Every other adapter in this module (`WorkdayAdapter`, `SapSuccessFactorsAdapter`, `SalesforceAdapter`, and the Phase 6 streaming adapters) calls Node's global `fetch` - the `undici`-backed implementation - with only a bearer-token `Authorization` header. Global `fetch` has no per-request option to attach a client certificate; `undici` supports mTLS only through its own `Agent`/`Client`/`Dispatcher` API, a different HTTP client surface than the rest of this module uses.

## Decision

`AdpAdapter`'s credential shape is real and complete - `credential.accessToken`, `credential.clientCertPem`, `credential.clientKeyPem`, all Vault-stored via the existing non-OAuth credential path (`IntegrationConnectorsService.create`'s `credentials` input, unchanged). `sync()` asserts all three are present before attempting any call and fails the `SyncJob` explicitly (`errorDetails.reason: 'missing_mtls_material'`) if the cert/key are absent - it does not fall back to a bearer-token-only request, which ADP's real API would reject anyway (and which would be a silently wrong "it looks like it's calling ADP" state). The actual mTLS handshake - wiring `clientCertPem`/`clientKeyPem` into an `undici.Agent` and using it as `fetch`'s `dispatcher` option for calls to this one provider - is not built this phase.

## Consequences

- **`AdpAdapter` cannot yet make a real authenticated call to ADP's actual API.** This is a genuine, disclosed limitation, not a hidden one: `fetchWorkers` will reach `missing_mtls_material` for any real ADP connector today, by design, rather than silently sending a request ADP will reject with a TLS-layer error this module can't see or explain to an operator.
- **Verification for this adapter is scoped accordingly** (see the Phase 6b design doc): the real local fake-ADP server used for testing accepts plain HTTP with only the bearer token, proving the field-mapping/dry-run/commit/conflict pipeline and the credential-shape/gap-detection logic - it does not prove a real mTLS handshake, because there is nothing in this environment to terminate one against.
- **The real fix**, when a tenant actually needs a live ADP connector, is to build a small `undici.Agent`-based HTTP client specifically for this adapter (reading `clientCertPem`/`clientKeyPem` from the already-correct Vault shape) and pass it as `fetch`'s `dispatcher` - a scoped, contained change to `AdpAdapter.fetchWorkers` alone; no other adapter or shared HTTP helper needs to change, since no other provider this module supports requires mTLS.
