# Module 10 Phase 3 Production Readiness Checklist

## Delivered in this phase (application code)

- [x] `TenantScopeAssertionService.assertSameTenant` writes a durable
      `AuditLog` entry (`actor_type: 'system'`,
      `action: 'security.cross_tenant_data_assembly_detected'`) on every
      violation, in addition to the existing `Logger.error` line and
      `ai_tenant_scope_assertion_failures_total` metric (ADR-0118).
- [x] The audit write is defensively wrapped in its own `try`/`catch` —
      the security rejection (`CrossTenantDataAssemblyError`) always fires,
      even if the audit write itself somehow fails.
- [x] `assertSameTenant` is now `async`; `ScheduleExplanationService`'s
      call site and every existing unit test updated to `await` it.
- [x] Two new unit tests: the durable audit write happens with the exact
      expected payload on mismatch; a rejected audit-client call never
      suppresses the security rejection itself. 27 tests total (up from
      25), all passing.

## Explicitly NOT done here (later phases, named in §9)

- [ ] No generic multi-source "query router" abstraction was built for
      assembling facts from N gRPC responses — `assertSameTenant` already
      accepted an array of facts since Phase 2; Phase 4's first real
      multi-module caller (`root_cause_analysis`) is what should drive any
      further abstraction, not a guess made ahead of a real second caller.
- [ ] §0.5's chaos/game-day scenario ("simulate a crafted query attempting
      cross-tenant data access ... demonstrated working, not just designed
      on paper") is unit-verified (a mocked mismatch is rejected and
      audited) but **not run as a live exercise against a running
      instance with a real, reachable core gRPC server** — see the gap
      below.
- [ ] The real security/red-team review of §5 (this module's own standing
      pre-launch gate, restated at every phase until it happens) — still
      not done, still not substituted for by this phase's own real, tested
      mitigations.

## Verification performed

- [x] `npm run typecheck` / `npm run build` / `npm test` (27/27) — clean.
- [x] Real, live re-boot (`NestFactory.create` + `app.listen`) against the
      same real running Postgres instance used in Phase 1/2, confirming
      this change didn't break DI wiring.

## Honestly disclosed gap (not glossed over)

- [ ] **Core's gRPC server (port 5000) is not reachable as gRPC in this
      sandbox** — confirmed directly with a `grpc.Client.waitForReady`
      probe, which times out. This is the same pre-existing environment
      gap ADR-0115 already found (via an HTTP/1.1 403 response instead of
      gRPC/HTTP2 on the same port). Consequence specific to this phase:
      the actual "does the row land in `core.audit_log`" outcome of a
      tenant-scoping violation could not be demonstrated live in this
      session. What *was* verified: `AuditGrpcClientService.recordEvent`
      is called with the correct payload (unit-tested against a mock), and
      `AuditGrpcClientService`'s own best-effort catch means this call's
      failure is silently logged, not thrown — confirmed by both this
      module's own unit tests and by direct observation in this session
      (the probe above). Whoever next has a reachable core gRPC server
      should confirm the row actually lands in `core.audit_log` for real,
      closing out this phase's own chaos/game-day ask completely.
