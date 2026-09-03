# Module 05 Phase 8 (Final) Design Doc — Multi-Region Design + Observability/Hardening

**Status:** Approved for implementation
**Owner:** Intraday pod (Module 05)
**Scope:** §6.2's regional topology (application-layer design only, per
§9's own non-goal on actual infra provisioning), a real Grafana
dashboard, and `docs/module-05-runbook.md`. This is Module 05's final
phase.

## Problem

§6.2 asks for a regional-Redis-cluster/regional-NATS-cluster topology
design and explicitly names what's this module's own responsibility
("regional-aware key/subject naming, region-aware routing") versus an
infra deliverable ("actual multi-region infrastructure provisioning").
Two real questions had no existing precedent:

1. Does "regional-aware key/subject naming" mean a region token inside
   every Redis key/NATS subject, or does each region run its own
   entirely separate stack with nothing shared to namespace? Confirmed
   `Tenant.dataResidencyRegion` (Module 01) is real but an unconstrained
   `varchar` - not even a standardized region-code vocabulary exists
   upstream to namespace against yet.
2. What's concretely left to build in an "observability/hardening"
   phase, given Phase 7 already shipped the Redis heartbeat, NATS
   consumer lag gauge, and a load test validating the stated SLOs?

See ADR-0072 for the full reasoning.

## Decision

- **Topology**: independent per-region stacks (own Redis, own NATS, own
  service instances per region), not a shared keyspace with
  region-prefixed keys - no change to any existing Redis key or NATS
  subject shape. `Tenant.dataResidencyRegion` stays a freeform field;
  this module doesn't invent a canonical region-code enum for Module 01's
  own entity.
- **`INTRADAY_REGION`**: a new config value (default
  `'single-region-dev'`), exposed on `GET /readyz`'s response body
  (`src/common/health/health.controller.ts`) - the one small, real,
  additive piece of this module's own "region-aware" responsibility:
  making this instance's region identity observable, not enforcing
  tenant-to-region routing itself (that's the gateway/DNS layer's job,
  explicitly out of scope per §9).
- **Cross-region aggregation**: designed only (reading each region's
  Postgres rollup tables), not built - no second region exists to build
  it against yet.
- **`observability/grafana-dashboard-module-05.json`**: a new,
  auto-loaded dashboard (the existing provisioning config scans a whole
  directory, not one hardcoded filename) covering every metric this
  service actually emits across Phases 1-7 - ingestion/REST-snapshot SLO
  panels, Redis health, NATS consumer lag/publish latency, ingestion
  outcome breakdown, process health. One panel is a markdown note, not a
  graph: the `queueLiveStateUpdated` push-latency SLO has no continuous
  metric (ADR-0072) - flagged explicitly on the dashboard itself, not
  silently absent.
- **`observability/prometheus.yml`**: one new scrape target
  (`agno-wfm-intraday-service`, port 8200), same pattern as the two
  existing entries.
- **`docs/module-05-runbook.md`**: same format as
  `docs/module-04-runbook.md` - real SQL/metric snippets for Redis
  outage response, NATS consumer lag/poison messages, alert/reallocation
  troubleshooting, partition/retention maintenance, migration rollback,
  closing with a consolidated "Standing gaps" section.

## Blast radius

One new ADR, one new Grafana dashboard JSON, one new Prometheus scrape
entry, one new runbook. One small source change:
`HealthController`/`HealthModule` gain a `ConfigService` dependency and
a `region` field on `/readyz`'s response. No schema/migration change, no
Redis key/NATS subject shape change, no new npm dependency.

## Rollback plan

Delete the new dashboard JSON and runbook, revert the
`prometheus.yml` scrape-config addition, revert `HealthController`'s
`region` field/`ConfigService` dependency. Nothing outside this phase
depends on any of it.

## Explicit assumptions

1. Region is a deployment/topology-level dimension, not a per-key/
   per-subject namespace dimension.
2. `Tenant.dataResidencyRegion` stays freeform - no enum defined here.
3. Tenant-to-region routing enforcement is an infra/gateway concern, not
   built in this service.
4. The cross-region aggregation service is designed, not built.
5. The `queueLiveStateUpdated` push-latency SLO has no continuous
   metric - validated only via periodic `scripts/load-test.ts` runs.

## Out of scope for this phase

- Actual Redis Cluster/NATS Supercluster provisioning.
- DNS/GSLB or any real tenant-to-region routing implementation.
- A canonical region-code enum for `Tenant.dataResidencyRegion`.
- The cross-region aggregation service itself.
- A Prometheus metric for subscription push latency.
- Publishing to `AGNO_INTRADAY_DLQ` on a poison message (pre-existing
  gap since Phase 1, named in the runbook, not fixed here).
- Real tenant/actor authentication (same pre-existing, platform-wide
  gap, not re-litigated here).
- Single-instance PubSub / consumer partitioning (ADR-0063/0068, still
  deferred - named in the runbook's own "Standing gaps," not solved
  here).

## Verification

- `npm run typecheck && npm run build && npm run lint && npm test` -
  `test/unit/health.controller.spec.ts` extended to cover the new
  `region` field (both the success path and the 503 path still carrying
  it implicitly via the same code path) and the `INTRADAY_REGION`
  default.
- Booted the service, confirmed `GET /readyz`'s response body includes
  `region: 'single-region-dev'` for real.
- Validated `observability/grafana-dashboard-module-05.json` is
  syntactically valid JSON with the expected panel structure.
- Validated `observability/prometheus.yml`'s new scrape entry is
  syntactically valid YAML.
- One ADR (0072).
- This design doc + `docs/module-05-phase-8-production-readiness-checklist.md`
  (this module's final checklist, indexing back to every prior phase's
  own).
