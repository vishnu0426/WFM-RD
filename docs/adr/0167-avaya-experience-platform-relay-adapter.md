# ADR-0167: Avaya Experience Platform gets a real `StreamingRelayAdapter`; Avaya Aura Contact Center/CMS stays deferred

## Context

ADR-0142 left both Avaya providers unbuilt in Phase 6b: Avaya Aura Contact Center/CMS because its real mechanism is TSAPI/CSTA over a licensed Avaya Aura Application Enablement Services (AES) instance - a DevConnect-gated CTI protocol this environment has no server or client library for - and Avaya Experience Platform (AXP) purely because Phase 6b's own provider list didn't name it, not because it was unbuildable. ADR-0142 itself called AXP "a real, sourced candidate for a future phase if a tenant needs it."

A customer now needs an AXP integration. `docs/module-12-provider-research.md`'s existing AXP section only carried the high-level shape (OAuth2, WebSocket-only Notification API, event type names, rough ping/expiry timings) - not the literal endpoint paths or message schemas a real, protocol-conformant client (this platform's established posture for every adapter since `WorkdayAdapter`) needs. Live verification against `developers.avayacloud.com`'s own "How to Authenticate with AXP APIs," "Notification Agent and Engagement," and "Notification Subscriptions" pages sourced the actual four-step wire shape:

1. `POST {base}/api/auth/v1/{accountId}/protocol/openid-connect/token` - OAuth2 client-credentials grant, credentials in the form body (`grant_type`/`client_id`/`client_secret`), not a Basic-auth header. A genuinely different credential shape from `GenesysCloudAdapter`'s token call.
2. `POST {base}/v1/accounts/{accountId}/subscriptions` - body `{family:"AGENT_ENGAGEMENT", events:["ALL"], transport:{type:"WEBSOCKET"}}`, response carries `subscriptionId`, `transport.endpoint`, and `pingInterval` (default 300s).
3. Open a WebSocket to `transport.endpoint` and send `{event:"authentication", subscriptionId, token}` as the first frame - a WS-level handshake Genesys's pure-REST provisioning dance doesn't have. The server replies with a `status` field (`CONNECTION_CONFIRMED` or one of several `CONNECTION_FAILED_*` values).
4. Periodic `{event:"ping"}` frames at the server-supplied `pingInterval`, acked with `{event:"pong"}`, to keep the session alive.

Event notifications arrive as `{correlationId, subscriptionId, family, sentAt, accountId, loginId, body:{...}}`, where `body.event` is `AgentState` (fields: `agentId`, `profileId`, `state`, `reasonCode`, `cause`, `id`, `timestamp` - epoch millis, not a string), `AgentParticipant`, or `InboundEngagementCreated`. Only `AgentState` maps to Module 05's activity-state concept; the module subscribes to `events:["ALL"]` and filters client-side rather than relying on an unconfirmed per-event subscription syntax.

Avaya Aura Contact Center/CMS's blocker is unchanged by this - no licensed AES/TSAPI environment exists here to verify a client against, and this platform's posture (restated in ADR-0142) is not to fabricate an unverifiable binary-protocol client. That remains deferred.

## Decision

Add `AxpAdapter` (`src/sync/relay/providers/axp.adapter.ts`) implementing `StreamingRelayAdapter` for `provider: 'Avaya Experience Platform'`, following `GenesysCloudAdapter`'s reference shape (ADR-0141): real four-step provisioning, `FieldMapping`-driven transform into `ActivityEvent`, forwarding via the existing `IntradayActivityEventClient`, and the same unbounded-exponential-backoff reconnect posture on an unexpected close (re-running the full dance, since AXP's own docs don't confirm whether a closed session's subscription is resumable - the same conservative choice Genesys's *confirmed* non-resumability motivates, applied here without that same confirmation). Wired into `STREAMING_RELAY_ADAPTERS` in `sync.module.ts` alongside the four existing streaming adapters.

`ProviderRateLimitConfig`'s existing `'Avaya Experience Platform'` seed row (Phase 5) already matches this adapter's `provider` string exactly - no migration change needed.

Avaya Aura Contact Center/CMS gets no adapter. ADR-0142's reasoning there is unchanged.

## Consequences

- A tenant's AXP connector config needs `axpApiBaseUrl` (the per-region host serving both the token and subscriptions paths), `axpAccountId` (AXP's own tenant-scoping segment, distinct from this platform's `tenantId`), and a `credentialReference` pointing at a Vault secret with `clientId`/`clientSecret`.
- No real credentialed AXP account exists in this environment. Verification (`test/integration/axp-adapter.spec.ts`) runs against a real local HTTP+WebSocket server implementing this exact four-step shape - the same "real local double of the actual wire protocol" posture as every other adapter, not a mock of `AxpAdapter` itself.
- `AgentParticipant`/`InboundEngagementCreated` events are received (the subscription is `events:["ALL"]`) but intentionally dropped - Module 05's `ActivityEvent` has no field for engagement/participant data, and there's no second Module 05 endpoint for it yet. Only `AgentState` is real, forwarded traffic today.
- `RelayAdapterRegistry.find('Avaya Experience Platform')` now returns a real adapter instead of `undefined`; `find('Avaya Aura Contact Center / CMS')` (or any string naming that provider) still returns `undefined` and fails cleanly with `no_adapter_registered`, unchanged from ADR-0142.
