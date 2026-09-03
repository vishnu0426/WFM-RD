# Phase 7 Production Readiness Checklist

## Delivered in this phase (application code)

- [x] **`TenantContextMiddleware` JWT-derived tenant context** (ADR-0049) -
      closes a real, exploitable cross-tenant bypass: a valid access token
      for tenant A plus a forged `X-Tenant-Id` header could previously
      execute RBAC-gated requests against tenant B's RLS context. Every
      `PlatformGraphQLModule` resolver and every controller added from
      Phase 4 onward was affected. Regression-tested
      (`test/unit/tenant-context.middleware.spec.ts`).
- [x] OpenTelemetry tracing (`src/tracing.ts`) - auto-instrumented HTTP/
      Express/pg/ioredis, fail-open with no reachable OTLP collector.
- [x] Prometheus metrics (`GET /metrics`) - HTTP/GraphQL/gRPC request
      duration + count, three durable-queue-depth gauges.
- [x] Health checks (`GET /healthz`, `GET /readyz`).
- [x] SLO dashboard (`observability/grafana-dashboard.json`), auto-
      provisioned via new docker-compose `prometheus`/`grafana` services -
      panels for every named §0.5 SLO target this repo has infrastructure
      to measure.
- [x] Chaos/game-day runbook section (six concrete scenarios) + a fillable
      incident postmortem template, replacing the one-line placeholder.
- [x] CI hardening: CodeQL SAST workflow, `npm audit --audit-level=critical`
      blocking gate (+ `high` informational report), CycloneDX SBOM
      generation uploaded as a build artifact (ADR-0051).
- [x] Unit tests: `TenantContextMiddleware`'s JWT-vs-header precedence
      (including the exact forged-header attack scenario), `HttpMetricsInterceptor`'s
      HTTP/GraphQL/gRPC route-label resolution (including the gRPC-context
      bug this phase caught and fixed during its own testing),
      `HealthController`'s liveness/readiness logic.

## Explicitly NOT done here (needs a different owner, or a later phase, before go-live)

- [ ] **Alerting/paging.** The Grafana dashboard is for humans to look at;
      no Alertmanager rules, no PagerDuty/Opsgenie integration, nothing
      pages anyone automatically on an SLO breach.
- [ ] **Ratcheting the `npm audit` CI gate beyond `critical`.** 22 moderate
      + 12 high pre-existing findings exist today (Express's `qs`/`multer`,
      `ws`, `uuid`, `tmp`/`inquirer`, `webpack`, `undici` - all transitive,
      all requiring a breaking major-version upgrade of the owning
      `@nestjs/*` package to clear). A real, tracked gap - not silently
      swept under the rug (ADR-0051), but not force-fixed here either,
      since that's a breaking-change remediation project of its own,
      needing its own full regression pass.
- [ ] **A container image build.** No `Dockerfile`/image build exists
      anywhere in this repo - SBOM generation covers the application
      dependency tree from `package-lock.json`, not a built artifact. Full
      SLSA/provenance attestation remains blocked on this.
- [ ] **RBAC retrofit onto Module 02's pre-Phase-4 surface.** ADR-0049's
      hardening only closes the bypass for RBAC-gated (Phase 4+) endpoints;
      Module 02's original org/employee/skill/calendar REST+GraphQL surface
      still has no `AccessTokenGuard` at all, unchanged risk profile from
      every earlier phase's own deferral of this exact retrofit.
- [ ] **Real chaos-engineering tooling.** The game-day runbook section is a
      manual exercise guide (kill a container, observe the dashboard,
      confirm the documented degraded-mode behavior holds) - no Gremlin/
      Chaos Mesh/automated fault-injection tool is integrated, and no
      recurring scheduled game day exists yet.
- [ ] **Distributed trace sampling/retention policy.** `src/tracing.ts`
      exports every span when an OTLP endpoint is configured - no sampling
      strategy (head-based, tail-based) is configured, which matters once
      there's real production request volume and a collector with a real
      retention/cost budget.
- [ ] **Log aggregation.** `Logger.log`/`.warn`/`.error` calls throughout
      this codebase are structured enough to be useful (consistent
      `[ServiceName]` prefixing via Nest's own `Logger`), but nothing ships
      them anywhere centralized (no Loki/ELK/CloudWatch/Datadog sink
      configured) - they only exist in whatever captures stdout today.
- [ ] **A live OTLP collector, Prometheus, and Grafana were not available
      to actually run against in this environment** - `src/tracing.ts` and
      `MetricsModule` are typechecked and unit-tested against mocked
      dependencies; `observability/grafana-dashboard.json` is valid JSON
      and its PromQL expressions are believed correct against the metric
      names this repo actually emits, but no query was executed against a
      live Prometheus to confirm a panel renders as intended.
- [ ] **Load testing informed by the new metrics.** The dashboard now
      exists to *measure* load, but no load test has been run against it
      yet - same gap named in every prior phase's own capacity-planning
      section.
- [ ] **Penetration testing / SOC2 / ISO27001 program.** Same explicit
      non-goal as every previous phase (§9 of the source spec).
