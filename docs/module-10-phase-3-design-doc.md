# Module 10 Phase 3 Design Doc — AI Layer: Tenant-Scoping Verification, In Full

**Status:** Approved for implementation
**Owner:** AI Layer pod, Principal AI Safety/Security Engineer owning this
phase specifically — §9's own instruction: "build and test this before
adding more interaction types, since every subsequent phase depends on it
being correct."
**Scope:** §5.1 "in full, including the security-event logging on
assertion failure." Phase 2 already built and unit-tested the core
mechanism (`TenantScopeAssertionService`) because `explainSchedule` needed
it immediately — Phase 3's job is to close the one real gap that mechanism
still had (a durable, queryable record of a violation, not just an
in-process log line) and to prove, deliberately, that this is solid before
Phase 4 hands it more than one gRPC source at once.

## Problem

Re-reading §0.5's on-call table against what Phase 2 actually built
surfaced a real, specific gap: "any tenant-scoping verification failure
... should page accordingly" implies an incident-response process that
needs to *investigate* after being paged, and a `Logger.error` call plus a
Prometheus counter answers "how often" but not "which request, which
tenant, which mismatched tenant" in any form that survives a process
restart or is queryable days later. Every other audited action in this
platform already has exactly this durability via `GET /v1/audit-log` — a
tenant-scoping violation, arguably the single most security-sensitive
event this module can produce, did not.

## Decision

`TenantScopeAssertionService.assertSameTenant` now writes a durable
`AuditLog` entry (`actor_type: 'system'`,
`action: 'security.cross_tenant_data_assembly_detected'`) via
`AuditGrpcClientService` before throwing, in addition to the existing log
line and metric — see ADR-0118 for the full reasoning, payload shape, and
the defensive `try`/`catch` around the audit call itself (the rejection
must fire even if the audit write can't).

No new abstraction was introduced for "assemble facts from N gRPC
responses" — `assertSameTenant` already accepted an array in Phase 2,
anticipating exactly this. Building a generic multi-source query-router
abstraction now, with only one real caller (`explainSchedule`, one
source), would be designing for a shape Phase 4's actual second caller
hasn't validated yet — deferred until there's a real second call site to
generalize from.

## Consequences / Verification

- `assertSameTenant` is now `async` — every call site (`ScheduleExplanationService`)
  and every unit test updated accordingly.
- 27 unit tests, all passing (up from 25) — two new cases: the durable
  audit write happens with the correct payload on a violation, and a
  failure in the audit write itself never suppresses the security
  rejection.
- Real, live re-verification: `npm run typecheck`/`build`/`test` clean,
  and a real `NestFactory.create` + `app.listen` boot against the actual
  running Postgres instance succeeded again after this change.
- **Honestly disclosed, not glossed over**: a direct gRPC `waitForReady`
  probe against `localhost:5000` (core's gRPC server) in this sandbox
  times out — the same pre-existing environment gap ADR-0115 already
  found. This means the actual "row lands in `core.audit_log`" outcome
  could not be demonstrated live in this session; what's verified instead
  is that the correct call is made with the correct payload, and that its
  failure doesn't suppress the rejection. Whoever next has a reachable
  core gRPC server should confirm the row actually lands, as the closing
  half of this phase's own chaos/game-day ask (§0.5: "simulate a crafted
  query attempting cross-tenant data access ... needs to be demonstrated
  working, not just designed on paper").
- What's next: Phase 4 (`explainForecast`/`reallocationRationale`/
  multi-module `root_cause_analysis`) is the first real exercise of
  `assertSameTenant` with more than one `TenantScopedFact` in a single
  call — this phase's own test coverage (`rejects on the first mismatch
  even when a later fact would have matched`) already proves the
  multi-fact path works, ahead of a real multi-module caller needing it.
