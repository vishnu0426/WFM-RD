# ADR-0118: a §5.1 tenant-scoping violation writes a durable, queryable `AuditLog` entry, not just an in-process log line and a metric

## Context
§9's own Phase 3 instruction is explicit: "§5.1 in full, **including the security-event logging on assertion failure** — build and test this before adding more interaction types, since every subsequent phase depends on it being correct." Phase 2 already built the core mechanism (`TenantScopeAssertionService.assertSameTenant`, unit-tested for match/mismatch/first-mismatch-wins), but its only record of a violation was a `Logger.error` call (stdout, lost on restart, not queryable) and a Prometheus counter (a rate, not a record of *which* request).

§0.5's on-call table is explicit that "any tenant-scoping verification failure at the query router" is "a potential security incident, not a routine error, and should page accordingly." A page without a queryable record to investigate against is an incomplete response mechanism - whoever gets paged needs to be able to ask "did tenant X's data ever actually reach tenant Y" against something durable, the same way `GET /v1/audit-log` already answers that question for every other audited action in this platform.

## Decision
`TenantScopeAssertionService.assertSameTenant` now also calls `AuditGrpcClientService.recordEvent` on every violation, before throwing `CrossTenantDataAssemblyError`:

- `actor_type: 'system'` - this is the platform's own control noticing the violation, not a human decision and not an AI-generated action. `ai_rationale` is correctly omitted (core's `AuditEventBatcherService` only requires it for `actor_type: 'ai_agent'`).
- `action: 'security.cross_tenant_data_assembly_detected'`, `resource_type: 'tenant_scope_assertion'`, `resource_id: <sourceModule>` - queryable by module, the same way any other audited resource type is.
- `after_state_json` carries the requesting tenant, the mismatched tenant, and the source module - everything an investigator needs without re-deriving it from application logs.

The audit write is wrapped in its own `try`/`catch`, independent of `AuditGrpcClientService`'s own already-best-effort contract - the actual security control (the `throw`) must fire even if a future change to the audit client ever violated its "never throws" contract. `assertSameTenant` is now `async` (`Promise<void>`) to accommodate the `await`; every call site was updated accordingly.

## Consequences
- A tenant-scoping violation is now visible in two independent places: `GET /v1/audit-log` (durable, queryable, survives a restart) and `/metrics`'s `ai_tenant_scope_assertion_failures_total` (rate, for alerting) - not just a log line that could scroll off before anyone looks.
- **Verified in this session that core's gRPC server is not currently reachable in this sandbox** (a direct `waitForReady` probe against `localhost:5000` times out) - meaning a live end-to-end "the audit row actually lands in `core.audit_log`" demonstration was not possible here. What *is* verified: the correct call is made with the correct payload (unit-tested), and a failure to make that call never suppresses the security rejection itself (also unit-tested, by forcing the mocked audit client to reject). This is the same class of environment-gap disclosure ADR-0115 already made for this session, not a new kind of gap.
- Every later interaction-generating service inherits this behavior for free, since they all share the one `TenantScopeAssertionService` - no per-interaction-type re-implementation needed when Phase 4 adds more callers.
