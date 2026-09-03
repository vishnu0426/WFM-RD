# ADR-0072: multi-region topology as independent per-region stacks, INTRADAY_REGION self-awareness, and the un-metered subscription-push SLO

## Context
§8 phase 8, this module's last, asks for "§6.2's regional topology
(application-layer scope only, flag the infra portion explicitly)."
§6.2 itself and §9's non-goals are explicit that actual multi-region
infrastructure (Redis Cluster/NATS Supercluster provisioning, DNS/GSLB
routing) is a DevOps/Cloud deliverable this module does not build - only
the application-layer design, and "what's in scope for this module
(regional-aware key/subject naming, region-aware routing) vs. what's an
infra deliverable."

Two real questions had no existing precedent to resolve:

1. **Does "regional-aware key/subject naming" mean embedding a region
   token into every Redis key/NATS subject, or does each region run its
   own entirely separate deployment with no shared keyspace at all?**
   Confirmed via `Tenant.dataResidencyRegion`
   (`src/modules/tenant/entities/tenant.entity.ts:38-39`) that this
   field is real but a freeform `varchar(50)`, no `CHECK` enum (unlike
   `tier`/`status`, which do have one) - so even the region-code
   vocabulary itself isn't yet standardized upstream.
2. **What, concretely, is left for this observability/hardening phase to
   build**, given Phase 7 already shipped the Redis heartbeat, NATS
   consumer lag gauge, and the load test that validates the stated SLOs?

## Decision

**Topology: independent per-region stacks, not a shared keyspace.**
§6.2's own phrasing - "Redis state should be regionally located near the
agents generating it... design the regional-Redis-cluster **topology**"
- describes separate per-region clusters, not one shared cluster with
region-prefixed keys. Each region runs its own complete stack (Redis,
NATS/JetStream, this service's own instances), serving only tenants
whose `data_residency_region` matches that region. **No region token is
added to any Redis key or NATS subject** - retrofitting one into every
key/subject this service has used since Phase 1 would be a large,
invasive schema change serving no purpose in a shared-nothing-per-region
topology, where the region boundary is *which entire stack* a request
lands on, not a namespace within one.

**What this module's own code is responsible for**: making this
instance's own region identity observable, so a future gateway/routing
layer - and this instance's own logs/metrics/on-call tooling - can be
checked against the intended topology rather than silently trusting DNS
routing did the right thing. A new `INTRADAY_REGION` config value (env
var, defaulted `'single-region-dev'`), exposed on `GET /readyz`'s
response body (`src/common/health/health.controller.ts`). Deliberately
small and additive - this service does not attempt to verify a given
request's tenant actually belongs on this region (that's the
gateway/DNS layer's job, decided before the request ever reaches this
service) - see Consequences.

**Cross-region aggregation** (design only, not built): a tenant needing
one consolidated dashboard spanning regions is served by a future,
lightweight aggregation service reading each region's Postgres rollup
tables (`adherence_daily_rollup`/`adherence_hourly_rollup`, Phase 3) -
not raw event replication across regions, matching §6.2's own suggestion.

**The `queueLiveStateUpdated` push-latency SLO (p99 < 500ms) has no
continuous Prometheus metric.** Phase 7's load test validated it
end-to-end via a client-side, hand-rolled sequence-number correlation
(publish timestamp → WS receipt), not a metric this service itself
emits - building one would need publish-timestamp propagation through
the whole NATS → consumer → in-process PubSub → `graphql-ws` chain, real
but nontrivial work. This phase's Grafana dashboard
(`observability/grafana-dashboard-module-05.json`) has panels for the
other two SLOs (ingestion, REST snapshot) and explicitly **no** panel
for this one - a flagged gap, not a silently missing one.

## Consequences
- This service never rejects or redirects a request based on region
  mismatch - if a gateway/DNS misroute sends a wrong-region tenant's
  traffic here, this service processes it exactly as any other tenant's,
  with no application-layer guardrail. Real region-boundary enforcement
  is entirely the infra/gateway layer's responsibility (§9's own
  boundary) - this is a real, accepted gap in application-layer
  defense-in-depth, not an oversight.
- `Tenant.dataResidencyRegion` staying a freeform `varchar` (not
  standardized by this phase) means `INTRADAY_REGION`'s own value has no
  guaranteed vocabulary match against it either - both are free strings
  an operator must keep consistent by convention, not by any enforced
  constraint. Standardizing this is Module 01's call, not retroactively
  fixed here.
- The `queueLiveStateUpdated` SLO has no live dashboard/alerting
  coverage - regressions there would only surface via a re-run of
  `scripts/load-test.ts` (Phase 7) or a user-reported complaint, not a
  Prometheus alert. Named explicitly in this phase's production
  readiness checklist and runbook, not glossed over.
- No actual multi-region deployment exists to validate any of this
  design against - it is exactly what §6.2 asked for (design, not
  infrastructure), and remains unverified against a real second region
  until an actual DevOps/Cloud provisioning effort stands one up.
