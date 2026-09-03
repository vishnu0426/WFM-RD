# ADR-0050: OpenTelemetry tracing, Prometheus metrics, and health checks - all fail open, none gate correctness

## Context
§1 names observability as a platform requirement; Phase 2's own design doc
named the specific deferred pieces by name: "OpenTelemetry span wiring,
SLO dashboards, chaos/game-day exercises (Phase 7)." Nothing existed before
this phase beyond ad hoc `Logger.log`/`Logger.warn`/`Logger.error` calls
scattered through services (already reasonably disciplined - every outbox/
batcher/dispatcher retry-then-DLQ path already logs at the right level -
but with no metric, trace, or dashboard behind any of it).

## Decision
**Tracing** (`src/tracing.ts`): `@opentelemetry/sdk-node` with
`getNodeAutoInstrumentations()`, imported as the literal first line of
`main.ts` (before `reflect-metadata`, before `AppModule` - OTel's
auto-instrumentation patches `http`/`express`/`pg`/`ioredis` by hooking
`require()`, so it has to run before anything else requires them). Exports
via OTLP HTTP only if `OTEL_EXPORTER_OTLP_ENDPOINT` is set - unset (true
for local dev and CI), spans are generated and processed in-process but
never shipped anywhere, and `sdk.start()` still succeeds cleanly. `/healthz`/
`/readyz`/`/metrics` are excluded from HTTP instrumentation (scrape noise,
not a business transaction).

**Metrics** (`MetricsModule`, `GET /metrics`): a thin `prom-client`
wrapper (`MetricsService`, same "thin wrapper, not a leaky abstraction"
posture as `RedisService`). `HttpMetricsInterceptor` (global
`APP_INTERCEPTOR`) records `http_request_duration_seconds`/
`http_requests_total` for **all three** transports this app serves - REST,
GraphQL, and gRPC (`context.getType() === 'rpc'`) - not just HTTP, because
§0.5's "IdentityService.ValidateToken/GetUserContext p99 < 50ms" SLO
target is a gRPC method; an interceptor that only understood
`switchToHttp()` would throw on every gRPC call rather than silently
under-counting it (caught and fixed during this phase's own testing - see
`test/unit/http-metrics.interceptor.spec.ts`'s dedicated `rpc`-context test
cases). Route labels use bounded-cardinality shapes (`req.route.path`
template for REST, `<Type>.<field>` for GraphQL, `<Controller>.<handler>`
for gRPC) - never raw URLs/ids, which would blow up label cardinality.
Three queue-depth gauges (`core_outbox_events_unpublished`,
`core_pending_audit_events`, `core_webhook_deliveries_pending`) use
`prom-client`'s `collect()` callback, so the underlying COUNT query only
runs when `/metrics` is scraped, not on a separate polling timer stacked on
top of the ones the outbox publisher/audit batcher/webhook dispatcher
already run.

**Health** (`HealthModule`): `GET /healthz` (liveness, no dependency
checks, always 200 if the process can respond) and `GET /readyz`
(readiness - Postgres `SELECT 1` and Redis `PING`, but only Postgres
unreachability flips the response to 503; a down Redis is reported but
doesn't fail readiness, matching §1's "Redis outage degrades latency, not
availability" posture already engineered into every Redis-touching
service).

**SLO dashboard** (`observability/grafana-dashboard.json`, dashboard-as-
code, auto-provisioned by the new docker-compose `prometheus`/`grafana`
services): panels map directly to §0.5's own named targets - IdentityService
gRPC p99 latency vs. the 50ms target, IdentityService gRPC availability vs.
99.95%, SSO callback success rate vs. 99.9% - plus general request rate/
error rate/latency, the three queue-depth gauges above, and Node process
health (RSS, event loop lag).

## Consequences
- Every piece here fails open by design, consistent with §1's Redis
  posture applied to observability generally: a broken/unreachable OTLP
  collector doesn't crash the app (`sdk.start()`'s own try/catch); a
  Prometheus scrape failure doesn't affect request handling (metrics
  recording is in-process, synchronous, and cheap); `/readyz` reporting
  `redis: "unreachable"` doesn't itself cause an outage. Observability
  code must never become a second thing that can take the platform down.
- No alerting rules exist yet (Prometheus `Alertmanager` config, PagerDuty/
  Opsgenie integration) - the dashboard is for humans to look at, not yet
  wired to page anyone automatically. Flagged in the readiness checklist,
  not silently implied.
- `TokenService.verifyAccessToken` being called an extra time per
  authenticated request (ADR-0049) is now visible in the p99 latency panel
  if it ever becomes a measurable cost - the dashboard is also the
  mechanism that would surface whether that accepted trade-off needs
  revisiting later, not just a claim in an ADR nobody re-checks.
- The gRPC route label (`<Controller>.<handler>`, e.g.
  `IdentityGrpcController.validateToken`) already distinguishes individual
  methods - the dashboard's p99 panel groups by this label, so
  `ValidateToken` and `GetUserContext` show as separate series even though
  the panel's query pattern-matches the whole controller. What it does
  *not* have is per-tenant or per-caller breakdown - every internal
  service's calls to a given gRPC method roll up into one series, so a
  single noisy caller degrading the aggregate p99 isn't distinguishable
  from a genuine platform-wide regression without cross-referencing traces.
