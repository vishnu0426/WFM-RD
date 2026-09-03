# Phase 7 Design Doc — Observability & Hardening

**Status:** Approved for implementation
**Owner:** Platform Core pod (Module 01)
**Scope:** §8 Phase 7 — the items Phase 2's own design doc deferred by
name ("OpenTelemetry span wiring, SLO dashboards, chaos/game-day exercises"),
the Phase 1 readiness checklist's own deferred SAST/dependency/SBOM gap,
the incident postmortem template `docs/runbook.md` carried as a forward
reference since Phase 1, and a security-hardening fix
(`TenantContextMiddleware`'s JWT-derived tenant binding) discovered while
auditing what "hardening" should mean for this specific codebase. Depends
on every prior phase's REST/GraphQL/gRPC surface already existing to have
something to observe.

## Problem

By the end of Phase 6, this module had a complete external API surface but
almost no way to see what it was actually doing in production: no traces,
no metrics, no dashboards, no health checks an orchestrator could probe,
and no documented incident-response process beyond a one-line "out of
scope" placeholder. Separately, re-reading ADR-0014's own consequences
section while scoping this phase surfaced that its explicitly-named
follow-up ("replace the header-trust placeholder with real JWT validation
once Module 01 ships it") had never actually happened, despite Module 01
shipping real JWT validation back in its own Phase 2 - leaving a genuine,
exploitable cross-tenant bypass live in every RBAC-gated endpoint added
from Phase 4 onward.

## Decision

**Security hardening** (ADR-0049): `TenantContextMiddleware` now derives
tenant context from a validated JWT's own claims whenever one is present,
ignoring `X-Tenant-Id`/`X-Platform-Admin` headers in that case entirely -
closing the bypass described above. This is listed first because it's the
one item in this phase that isn't purely additive observability - it's a
correctness/security fix to existing behavior, and is treated with
correspondingly more weight (a dedicated regression test encoding the
exact attack scenario, not just a design note).

**Tracing** (ADR-0050): OpenTelemetry auto-instrumentation
(`src/tracing.ts`), fail-open (no reachable OTLP collector required to
start cleanly), covering HTTP/Express/pg/ioredis automatically.

**Metrics** (ADR-0050): `GET /metrics` (Prometheus format),
`http_request_duration_seconds`/`http_requests_total` across all three
transports this app serves (REST, GraphQL, gRPC), plus three queue-depth
gauges tied directly to prior phases' own durable-queue patterns
(`core.outbox_events`, `core.pending_audit_events`,
`core.webhook_deliveries`).

**Health checks** (ADR-0050): `GET /healthz` (liveness) / `GET /readyz`
(readiness - Postgres-gated, Redis-reported-but-not-gating).

**SLO dashboard** (ADR-0050): `observability/grafana-dashboard.json`,
panels mapped directly to §0.5's own named targets (IdentityService gRPC
p99/availability, SSO callback success rate), auto-provisioned via new
docker-compose `prometheus`/`grafana` services.

**Chaos/game-day runbook + incident postmortem template**
(`docs/runbook.md`): six concrete failure-injection scenarios (Postgres
down, Redis down, NATS down, SIGKILL mid-flush, signing key compromised,
the ADR-0049 attack scenario itself), each naming the specific
already-engineered degraded-mode behavior a game day should verify still
holds - not a list of things to discover for the first time during a real
incident. A fillable postmortem template replaces the one-line placeholder.

**CI hardening** (ADR-0051): a CodeQL SAST workflow, an `npm audit`
vulnerability gate (scoped to `critical` - see that ADR for why `high`/
`moderate` aren't gated yet), and CycloneDX SBOM generation uploaded as a
build artifact on every run.

## Blast radius

- `TenantContextMiddleware`'s constructor gained a `TokenService`
  dependency and its `use()` method became `async` - every existing call
  site is `AppModule`'s own `consumer.apply(TenantContextMiddleware)`,
  unchanged. Behavior for requests with no Bearer token, or an invalid
  one, is byte-for-byte unchanged (ADR-0014's original path). Behavior for
  requests *with* a valid Bearer token changes: tenant context now comes
  from the token, not `X-Tenant-Id` - a real behavior change, but one that
  only ever makes previously-over-permissive requests *more* correctly
  scoped, never less (no legitimate caller was relying on being able to
  override their own token's tenant via a header).
- `main.ts` gained one new first-line import (`./tracing`) - no other
  change to bootstrap logic.
- Three existing repositories (`CoreOutboxEventsRepository`,
  `PendingAuditEventsRepository`, `WebhookDeliveriesRepository`) each
  gained one new additive `count`-style method for the metrics gauges -
  no change to any existing method.
- Six new npm dependencies (`prom-client`, five `@opentelemetry/*`
  packages) - all new code paths (`tracing.ts`, `common/metrics/*`), no
  existing import touched.
- `docker-compose.yml` gained two new services (`prometheus`, `grafana`) -
  additive, nothing depends on them being up.

## Rollback plan

Mostly additive - reverting `HealthModule`/`MetricsModule` from
`app.module.ts`, removing `src/tracing.ts` and its `main.ts` import, and
dropping the two new docker-compose services fully reverts the
observability half with no other code depending on any of it.
`TenantContextMiddleware`'s change (ADR-0049) is the one non-trivially-
revertible piece - reverting it means restoring ADR-0014's original
header-trust-only behavior, which means restoring the cross-tenant bypass
this phase was written specifically to close. Do not revert this half
without a clear replacement plan already in hand.

## Explicit assumptions (spec was ambiguous or silent here)

1. **The `TenantContextMiddleware` hardening was not explicitly requested
   by name anywhere in the source spec** - it was found by re-reading
   ADR-0014's own forward reference while scoping "hardening" for this
   phase, and judged in-scope because it's precisely the kind of gap a
   hardening pass exists to close, and because "make sure everything is
   implemented" (the instruction driving this phase) reasonably extends to
   closing a security gap the codebase's own prior ADRs flagged as
   outstanding, not just building new observability surface area.
2. **The dependency-vulnerability CI gate is scoped to `critical` only**,
   not `high` - see ADR-0051 for the full reasoning (22 moderate + 12 high
   pre-existing findings, all requiring breaking major-version framework
   upgrades to clear, judged out of scope for a CI-hardening change to
   force through silently).
3. **No alerting rules exist** - the Grafana dashboard is for humans to
   look at; nothing pages anyone automatically yet.
4. **No container image build exists**, so SBOM generation covers the
   application dependency tree (from `package-lock.json`), not a built
   artifact - full provenance attestation remains blocked on that image
   build existing at all (unchanged from the Phase 1 checklist's own
   framing).

## Out of scope for this phase (do not build yet)

- Alerting/paging (Alertmanager rules, PagerDuty/Opsgenie integration).
- Ratcheting the `npm audit` gate to `high`/`moderate` - a dedicated
  remediation project (ADR-0051).
- A container image build + full SLSA/provenance attestation pipeline.
- Retrofitting RBAC (and therefore closing ADR-0049's remaining
  unauthenticated-endpoint exposure) onto Module 02's pre-Phase-4 surface -
  a separate, deliberate piece of work each earlier phase already
  consistently deferred.
- An actual chaos-engineering tool integration (Gremlin, Chaos Mesh,
  a scheduled automatic game-day) - the runbook section is a manual
  exercise guide, not automated fault injection.
