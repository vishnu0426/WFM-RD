# ADR-0168: Avaya Aura Contact Center/CMS gets a real `StreamingRelayAdapter`, built against the public CSTA-XML standard rather than Avaya's gated TSAPI SDK

## Context

ADR-0142 deferred Avaya Aura Contact Center/CMS entirely: the mechanism real integrators (NICE, Verint, Medallia) build against is TSAPI over Avaya Aura Application Enablement Services (AES) - a licensed, DevConnect-gated CTI client library and Programmer's Guide, with no real AES instance or SDK available in this environment. That ADR's own posture: building a client with no real server to verify against, or wrapping an SDK that doesn't exist here, would be unverifiable fabrication.

A customer now needs this connector, and unlike this environment, they already run their own real AES. That resolves half of ADR-0142's blocker - there is now a real verification target, just not one this codebase provisions. It does not resolve the other half: Avaya's own TSAPI Client SDK (the thing every real integrator, including the open-source `pytapi`/`TSAPIClient` GitHub wrappers found during research, actually builds against) is still DevConnect-gated and unavailable here, and this adapter does not wrap it.

Instead, research turned up a legitimate alternative: **ECMA-323** ("XML Protocol for Computer Supported Telecommunications Applications (CSTA) Phase III") is a real, freely-published international standard - not Avaya's proprietary encoding - that defines a complete, literal wire protocol for CSTA services over plain TCP. The actual PDF (6th edition, December 2011, `ecma-international.org`) was downloaded and read directly (not summarized secondhand) to extract:

- **Annex J** ("CSTA XML over TCP"): the real message framing - 2-byte header (`0x00 0x00` = plain CSTA-XML, no SOAP), 2-byte big-endian length (full frame, prefix included), 4-byte ASCII Invoke ID (`"9999"` reserved for server-pushed events), ASCII XML body.
- **§13.1.2** `MonitorStart`/`MonitorStartResponse`, and **§A.5.3.5** `RequestSystemStatus` - schema-verified request/response shapes.
- **§20.2**, all six real agent-state event schemas: `AgentBusyEvent`, `AgentLoggedOffEvent`, `AgentLoggedOnEvent`, `AgentNotReadyEvent`, `AgentReadyEvent`, `AgentWorkingAfterCallEvent` - CSTA models each state transition as its own event type, not one event carrying a `state` enum (this matters: it's a structurally different shape than every other researched ACD provider in this codebase).
- **§9.2**'s `SubjectDeviceID`/`DeviceID` encoding and **§9.5**'s `MonitorObject`/`CSTAObject` choice type, needed to build a schema-correct `MonitorStart` request body.

Two real gaps remain, disclosed rather than papered over (both called out again in the adapter's own class doc comment and inline at the exact lines they matter):

1. **AES's application-level login/authorization before CSTA services begin is Avaya-specific and not defined by ECMA-323.** The standard's own `RequestSystemStatus` (§A.5.3.5) has an optional `security`/`privateData` extension pair (§9.8's `CSTACommonArguments`) that is the standard's sanctioned place for exactly this kind of credential material - and every other credential-shaped field ECMA-323 itself defines (`AccountInfo`, `AuthCode`, `AgentPassword`) is `xsd:hexBinary`. This adapter hex-encodes the tenant's credential into that field, following that established convention, but AES's actual expectation for its content is unconfirmed.
2. **None of the six agent-state event schemas carry a vendor-supplied unique event ID or timestamp** (unlike `GenesysCloudAdapter`'s `modifiedDate` or `AxpAdapter`'s `body.id`). `activityStartedAt` is this adapter's own receipt-time stamp; `sourceEventId` is synthesized from a per-connection counter. Unlike the other three streaming adapters, a genuine CSTA event retransmit is **not** deduped by Module 05 - the integration test (`avaya-aura-adapter.spec.ts`) asserts this real limitation explicitly rather than hiding it.

Applying `RequestSystemStatus` as the CSTA-association bootstrap for a bare TCP socket is this adapter's own inference by analogy: Annex C names "implicit association via Request System Status" explicitly, but only for the SIP-uaCSTA transport, not the plain-TCP case Annex J covers. This is a reasoned, sourced design choice, not a documented fact for this exact transport.

## Decision

Add `AvayaAuraAdapter` (`src/sync/relay/providers/avaya-aura.adapter.ts`) implementing `StreamingRelayAdapter` for `provider: 'Avaya Aura Contact Center / CMS'` (matching the `ProviderRateLimitConfig` seed row already in place since Phase 5). It speaks CSTA-XML directly over a raw `node:net` TCP socket per the real protocol sourced above, using a dedicated framing module (`csta-xml-frame.ts`, independently unit-tested against the standard's own byte layout - `test/unit/sync/csta-xml-frame.spec.ts`) and `fast-xml-parser` (a new real dependency; no XML parser previously existed in this service) for decoding.

Wired into `STREAMING_RELAY_ADAPTERS` in `sync.module.ts` alongside the five existing streaming adapters.

## Consequences

- A tenant's connector config needs `aesHost`, `aesPort`, `monitoredDeviceIds` (CSTA deviceIDs/extensions - ADR-0138/ADR-0141's "tenant supplies already-aligned IDs, no discovery call" posture, restated again here), and a `credentialReference` pointing at a Vault secret with `securityToken`.
- No real AES instance exists in this environment. Verification (`test/integration/avaya-aura-adapter.spec.ts`) runs against a real local TCP server that decodes/encodes the exact Annex J framing and speaks the schema-verified `RequestSystemStatus`/`MonitorStart` shapes - proof this adapter's *encoding* matches the public standard, explicitly **not** proof it matches a real AES's actual behavior. The two disclosed gaps above are the specific things a real customer AES environment needs to verify/adjust first.
- `RelayAdapterRegistry.find('Avaya Aura Contact Center / CMS')` now returns a real adapter instead of `undefined`.
- Avaya Experience Platform (AXP, ADR-0167) is unaffected - a separate, already-built adapter for a different Avaya product with a different (cloud, fully vendor-documented) transport.
