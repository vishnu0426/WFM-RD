# Module 12 — Integration Hub: Provider Research (ProviderRateLimitConfig seed source)

Research date: 2026-08-12. This doc is the sourced basis for the `ProviderRateLimitConfig` seed rows referenced in Module 12 §5a/§5c and in ADR-0134/ADR-0135. It is **not** itself a migration or seed script — Module 12's schema doesn't exist yet (Phase 1 hasn't run). When Phase 5 (rate limiting) and Phase 6 (first ACD connector) actually build `ProviderRateLimitConfig`, seed it from the `Seed row` blocks below, not from memory — re-verify anything marked `confidence: unconfirmed` against the vendor's admin console or account rep first, since several of these numbers are not vendor-published and enterprise SaaS rate limits shift without a changelog.

Every row below carries a `confidence` field:
- `vendor_published` — the vendor's own current docs state this number directly.
- `vendor_published_but_dynamic` — the vendor documents that limiting exists but explicitly declines to publish a fixed number (adaptive/tenant-health-based).
- `unconfirmed` — no public vendor source states this number; it's a third-party integrator/community proxy. Treat as a starting default only.
- `not_applicable` — the field doesn't fit this provider's actual constraint shape (see §5c's repurposing rule).

---

## Batch connectors (HRIS / payroll / CRM) — provider-quota throttling

### Workday (HRIS)
- **Auth**: OAuth 2.0 (Authorization Code or Client Credentials grant) is the documented modern path; access tokens ~3600s, refresh tokens can be set non-expiring for unattended batch jobs. The dominant production integration surface for many tenants is still the legacy SOAP Web Services (WWS) stack authenticated via WS-Security with an Integration System User (ISU) — not OAuth. A connector adapter must support both credential shapes.
- **Rate limit**: not published for REST API v1. Graph API documents adaptive limiting only ("we rate limit when queries/mutations start to impact tenant health") — no fixed number, 429 on breach.
- **Seed row** (`confidence: unconfirmed`, proxy from third-party integration guides, not Workday's own docs):
  `requests_per_window: 10, window_seconds: 1, concurrent_request_limit: null, backoff_strategy: {type: "exponential", base_ms: 1000, max_retries: 5, respect_retry_after: true}`
- **Bulk mechanism**: RaaS (Report-as-a-Service) — XML output paginates, JSON does not (third-party-reported ~2GB/30min ceiling on large JSON reports, unconfirmed). WQL (Workday Query Language) REST is a newer alternative.
- **Sources**: developer.workday.com REST API Headers & Error Messages refs (error `S14` = bulk-size cap, not a rate limit), Workday Graph API rate-limit doc, SailPoint Workday OAuth 2.0 connector docs.

### SAP SuccessFactors (HRIS)
- **Auth**: OAuth 2.0 via SAML Bearer Assertion exchanged at the token endpoint (SAP KBA 3462403); X.509 mTLS is an alternative credential type. HTTP Basic Auth is deprecated, with a cited sunset date of November 2026 — **already imminent as of this research date (2026-08-12)**; do not build a new adapter against Basic Auth.
- **Rate limit** (`confidence: unconfirmed` — SAP's own KBA calls these "still under development" / tenant-contract-specific, and the primary announcement blog returned HTTP 403 on direct fetch): commonly cited figures from SAP-partner integration guides referencing SAP's 2022 rate-limiting rollout (SAP KBA 3159263): **≤40 req/s for OData v2**, **≤20 req/s for SFAPI (SOAP)**, **max 10 concurrent requests/client** recommended.
- **Seed row** (seed conservatively below the cited ceiling): `requests_per_window: 30, window_seconds: 1, concurrent_request_limit: 10, backoff_strategy: {type: "exponential", respect_retry_after: true, observed_retry_after_default_s: 300}`
- **On breach**: HTTP 429 (confirmed, SAP KBA 3657473).
- **Bulk mechanism**: OData v2 `$batch`, explicitly recommended by SAP to stay under the limit for incremental syncs.
- **Sources**: SAP KBA 3159263, 3657473, 2516640, 3462403; SAP Community "Rate Limiting on SAP SuccessFactors APIs" (Apr 2022); SAP Community Basic Auth deprecation post.

### ADP (Payroll)
- **Auth**: OAuth 2.0 Client Credentials grant (`api.adp.com/auth/oauth/v2/token`), tokens expire in 3600s with no refresh-token rotation (re-request via client credentials on expiry). **Mutual TLS is required in addition to the bearer token** — a client cert from ADP's Partner Self-Service Portal, valid 2 years, is a hard prerequisite for every call. This is a materially different credential shape from the other batch providers and needs its own field in the non-OAuth/cert-handling design, not just a Vault-referenced bearer token.
- **Rate limit** (`confidence: unconfirmed` — ADP's own rate-limit page is JS-gated/partner-portal-auth and didn't render on direct fetch): third-party integration guide (Rollout.com) reports tiered limits — Default 300 calls/min, Tier 2 480/min, Tier 3 780/min — plus a **production-wide concurrency cap of 50 simultaneous calls (12 per node)**, where exceeding the per-node cap (not the aggregate) is the more common real-world trigger.
- **Seed row**: `requests_per_window: 300, window_seconds: 60, concurrent_request_limit: 50, backoff_strategy: {type: "exponential", note: "distribute across nodes; single-node concurrency (~12-13) is the more common real trip point than the aggregate cap"}`
- **On breach**: HTTP 429.
- **Bulk mechanism**: none distinct — batch sync uses the same rate/concurrency-gated REST endpoints with `$top`/`$skip` pagination.
- **Sources**: developers.adp.com Mutual SSL & CSR guides, ADP Marketplace ESI "Getting Started" PDF, Rollout.com ADP Workforce Now API guide, ADP DataCloud rate-limit PDF (separate product line, confirms ADP does publish hard numbers for some APIs).

### Salesforce (CRM)
- **Auth**: OAuth 2.0, Authorization Code or Client Credentials depending on Connected App config. No mTLS requirement for standard REST/Bulk access.
- **Rate limit** (`confidence: vendor_published` — Salesforce publishes exact numbers): daily API call cap on a **rolling 24h window**, shared across REST/SOAP/Bulk/Bulk 2.0/Connect: **100,000 + 1,000/full-user-license (Enterprise/API-enabled Professional)**, **100,000 + 5,000/full-user-license (Unlimited/Performance)**, flat **15,000/24h (Developer Edition)**. **Concurrent long-running-request limit: 25 (production), 5 (Developer/sandbox)**, each capped at 10 minutes.
- **Seed row**: `requests_per_window: 100000, window_seconds: 86400, concurrent_request_limit: 25, backoff_strategy: {type: "header_driven", header: "Sforce-Limit-Info", on_breach_status: 403, on_breach_code: "REQUEST_LIMIT_EXCEEDED"}`
- **Bulk mechanism** (`confidence: vendor_published`, separate quota pool from the daily call cap — must be tracked independently): Bulk API 2.0 — max **25 concurrent jobs** (1.0+2.0 combined), **15,000 batch submissions/24h**, ingest up to 150M records/24h at 150MB/job, query up to 15GB/job with a 20-minute timeout.
- **Sources**: developer.salesforce.com blog "API Limits and Monitoring Your API Usage" (Nov 2024), Salesforce App Limits Cheat Sheet, Bulk API 2.0 Developer Guide limits page (Summer '26 doc set).

---

## Streaming connectors (ACD/CCaaS) — relay backpressure, not provider quota

Per §5a/§5c, `requests_per_window`/`window_seconds` mostly don't fit these providers' real constraint. `concurrent_request_limit` is repurposed as "max concurrent monitored links/sessions/channels" where a vendor publishes one; where none is published, the constraint lives in `backoff_strategy` as a self-imposed relay-side cap, per ADR-0135.

### Genesys Cloud
- **Auth**: OAuth 2.0 Client Credentials grant; token lifetime configurable 300–172,800s (default 86,400s; HIPAA orgs force a 15-min idle timeout).
- **Real-time delivery**: **Notifications API — WebSocket + topic pub/sub** (e.g. `v2.users.{id}.presence`), not classic webhooks. This is the correct integration surface for agent-state relay.
- **Concurrency cap** (`confidence: vendor_published`): **max 1,000 topics per WebSocket connection** (HTTP 400 beyond that), **max 20 channels per client** (oldest inactive channel evicted beyond 20), one live connection per channel.
- **REST rate limit** (`confidence: vendor_published_but_dynamic`): enforced per-microservice, not globally; ceilings vary by API category (docs cite examples like ~1000 req/app/user, ~300 req/access-token for specific services) — no universal constant, must be checked per endpoint at implementation time.
- **On breach**: HTTP 429 with `Retry-After` header (documented — respect it).
- **Seed row**: `requests_per_window: null, window_seconds: null, concurrent_request_limit: 20, backoff_strategy: {type: "respect_retry_after", channel_topic_cap: 1000, note: "concurrent_request_limit repurposed per ADR-0135 as max WebSocket channels, not REST calls"}`
- **Sources**: developer.genesys.cloud Platform Auth, Rate Limits, Notifications overview & topic list, Developer Forum threads on channel/topic caps.

### NICE CXone
- **Auth**: OAuth 2.0, but the documented server-to-server pattern is **Resource Owner Password Grant** ("Back-End Apps"), not Client Credentials — an unusual auth shape relative to the other cloud ACD providers, worth flagging in the connector adapter's auth-type enum. Token TTL not publicly stated.
- **Real-time delivery**: no native outbound webhook for agent state. Documented mechanism is **long-polling via `get-next-event`** (comet/reverse-Ajax pattern, 0–60s hold); a newer Agent SDK offers a WebSocket channel with lower latency. True webhooks (Monitoring Gateway Subscriptions) exist for other data types but not natively for agent-state.
- **Concurrency cap** (`confidence: vendor_published`): **100 concurrent requests, uniform default across all customers**; requests beyond that queue rather than error; raising it requires an account-rep-approved exception.
- **On breach**: HTTP 429, no confirmed `Retry-After` — client-side exponential backoff is the documented fallback guidance.
- **Seed row**: `requests_per_window: null, window_seconds: null, concurrent_request_limit: 100, backoff_strategy: {type: "exponential", note: "no vendor-documented Retry-After; CXone's own docs state limits are 'not standardized' across APIs"}`
- **Sources**: developer.niceincontact.com Auth & Authorization doc, REST API throttle doc (help.nicecxone.com), UsingEvents / CXoneEventHubProvider SDK docs, Monitoring Gateway Subscriptions doc.

### Five9
- **Auth**: no single unified API — three distinct surfaces with different auth: legacy Config/Statistics SOAP (HTTP Basic Auth), SCIM REST (static long-lived bearer token, manual rotation only), and the real-time-relevant **Agent & Supervisor REST/WebSocket API** (session-based: authenticate to get session metadata, then open a WebSocket on that session).
- **Rate limit**: **not publicly documented for any surface** (`confidence: unconfirmed` — Five9's own community docs explicitly state this). WebSocket/Agent-Supervisor connections are gated by licensed-seat count, not a published req/s figure.
- **Real-time delivery**: WebSocket push over an authenticated session — not webhooks, not polling. A separate Event Subscription Service (ESS) covers discrete lifecycle events but explicitly **excludes real-time agent state**.
- **On breach**: not documented.
- **Seed row**: `requests_per_window: null, window_seconds: null, concurrent_request_limit: null, backoff_strategy: {type: "exponential", note: "fully undocumented by vendor; constrained in practice by licensed WebSocket seat count, not a published rate"}` — mark `is_published: false` explicitly rather than guessing a number.
- **Sources**: Five9 Community "Statistics Web Services Methods and Default Limits", "How to Use Websocket to Consume Realtime Events", Five9 Agent-Sup REST API Starter Kit (official GitHub dev-program repo).

### Talkdesk
- **Auth**: OAuth 2.0 — Client Credentials (server-to-server), Authorization Code, or Client Credentials + Private Key JWT. Token lifetime 3600s. Developer access is not self-service — requires CSM/partner-portal approval per client.
- **Real-time delivery**: two distinct mechanisms, not one — **Events/Webhook Trigger API** is genuine HTTP push with ECDSA-signed payloads and at-least-once delivery, but its event catalog is app-lifecycle only (`app.installed`, etc.), **not agent status**. Agent-state/queue metrics instead use the **Live API over Server-Sent Events**: client subscribes (≤16 metrics/subscription), then holds an SSE connection updated every 5–60s. The connector must terminate an SSE client, not a webhook receiver, for agent state.
- **Rate limit** (`confidence: vendor_published` for two specific surfaces only): **SCIM API: 4 req/s** (confirmed, multiple sources); **Explore/reporting API: 15 simultaneous reports** account-wide. General REST/Live API: not publicly published.
- **On breach**: HTTP 429 (confirmed for SCIM and Explore).
- **Seed row**: `requests_per_window: 4, window_seconds: 1, concurrent_request_limit: 15, backoff_strategy: {type: "exponential", scope_note: "4 req/s figure is SCIM-specific; Live API SSE has no published rate ceiling — backpressure there is self-imposed per ADR-0135"}`
- **Sources**: docs.talkdesk.com Authentication, Client Credentials, Events API, Live API, SCIM API pages.

### Avaya Experience Platform (AXP) — cloud, in scope now
- **Auth**: OAuth 2.0 — Client Credentials, Authorization Code (SAML/OIDC-capable), or Resource Owner Password. Access tokens expire in **900s**, refresh tokens in **9000s**. Clients are pre-registered via OneCare/CloudOps provisioning — not self-service.
- **Real-time delivery**: **"Agent and Engagement Events API"**, part of AXP's Notification API — **WebSocket transport only for v1**, despite "webhook" language appearing in marketing copy. Event types include `AgentState`, `AgentParticipant`, `InboundEngagementCreated`. Ping interval default 300s (client should ping every 30s through proxies); subscription expires after 900s of inactivity; inactive subscriptions live 24h.
- **Rate limit**: **not publicly documented** — confirmed absent from the developer portal, and an unanswered community question on developers.avayacloud.com corroborates this is genuinely undisclosed, not just hard to find.
- **On breach**: not documented.
- **Seed row**: `requests_per_window: null, window_seconds: null, concurrent_request_limit: null, backoff_strategy: {type: "exponential", is_published: false, note: "self-imposed conservative default only; no vendor number exists to seed against"}`
- **Sources**: developers.avayacloud.com "How to Authenticate with AXP APIs", "Notification Agent and Engagement", "Notification Subscriptions", "Analytics Realtime Data API", community rate-limit question thread.

### Avaya Aura Contact Center / CMS — on-prem, §5c decision pending
- **Correct mechanism**: **TSAPI via Avaya Aura Application Enablement Services (AES)** — CSTA-based event stream (`AgentStateChanged`, `AgentLoggedOn`, etc.), the mechanism actual WFM/recording integrators (NICE, Verint, Medallia) build against. CMS/CMS Supervisor ODBC is fundamentally historical/interval reporting against Informix tables (15/30/60-min storage intervals); integrator forum consensus is that no true real-time feed is exposed through ODBC despite a nominal "real-time database" with a 3s internal refresh. DMCC is a sibling AES service for device/media/call control, not the agent-state-event path.
- **Credentials**: CMS side — Informix DB username/password, licensed independently from Supervisor's own concurrent-login limit. TSAPI side — a CTI user account on AES plus the TSAPI client library (free to DevConnect members) and TSAPI SDK (gated to Gold/Platinum DevConnect tier or partner purchase). IP-allowlisting is plausible but **unconfirmed** in public docs.
- **Concurrency** (`confidence: unconfirmed` — integrator practice, not an Avaya-published hard cap): TSAPI licensed per concurrent session, with integrators commonly sizing ~1.5x licenses vs. concurrent channels needed. CMS ODBC connections are licensed in bundles of 5/10, with the actual server-side cap read from `oplrqb.ini` (exceeding it throws an explicit connection-limit error).
- **Polling interval, if ODBC fallback is used instead of TSAPI events** (`confidence: unconfirmed`): no Avaya-stated safe minimum; integrator proxy is **15–30s** for anything real-time-adjacent, aligned to the 15/30/60-min storage interval for genuinely historical tables.
- **Seed row**: `requests_per_window: null, window_seconds: null, concurrent_request_limit: null, backoff_strategy: {type: "n/a", note: "concurrent_request_limit repurposed per ADR-0135 as max TSAPI sessions or max ODBC connections depending on which mechanism §5c selects; both are licensing-tier constants configured per tenant deployment, not a vendor-published platform number"}`
- **Scope status**: research-only. Per Module 12 §5c/§8, whether the on-prem non-REST worker gets built is a separate resourcing decision, not implied by this research. Until that decision is made, Avaya support means AXP (cloud) only.
- **Sources**: documentation.avaya.com CMS Overview & Specification (r21), ODBC/JDBC interoperability guide, AES TSAPI/CVLAN client & SDK installation guide (DevConnect download page); support.avaya.com KB article referenced but gated behind support login, not independently verified; integrator forum threads (Tek-Tips) on CMS ODBC/DMCC real-time behavior, flagged as practice signal only.
