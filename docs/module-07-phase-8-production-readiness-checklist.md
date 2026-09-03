# Module 07 Phase 8 (Final) Production Readiness Checklist

This is Module 07's **final** phase. Unlike Module 05's own per-phase
checklist series, Phases 1-7 of this module did not each produce a
standalone checklist file - this document is self-contained: it covers
what Phase 8 itself delivered, then indexes the real, still-open gaps
named across the module's own ten prior ADRs (0082-0091) and this
phase's own runbook/load-test findings, followed by a closing summary of
what Module 07 actually is, end to end.

## Delivered in this phase

- [x] `scripts/load-test.ts` - the popular-shift-contention release-gate
      load test (§0.5/§7), run against real local Postgres/Redis/NATS, a
      real booted `shift-marketplace-service`, and a real booted
      `scheduling-service` gRPC eligibility server. Validated all three
      stated SLOs at 1,000 total claim attempts / 25 contended rounds -
      see `docs/module-07-phase-8-load-test-results.md` for full numbers
      and an honest "what this run does not validate" section.
- [x] `observability/grafana-dashboard-module-07.json` - a real Grafana
      dashboard covering every metric this service actually emits (all
      three SLO histograms, claim-attempt outcomes/anti-abuse visibility,
      HTTP request duration, process health), validated as structurally
      correct JSON, wired into `docker-compose.yml`'s `grafana` service
      (a mount line module-05/06's own dashboards were never given - a
      pre-existing gap in those modules, not fixed here, out of this
      module's scope to fix).
- [x] `observability/prometheus.yml` scrape entry for this service's own
      `/metrics` (port 8400), validated as structurally correct YAML
      matching the four existing entries' shape.
- [x] `docs/module-07-runbook.md` - real operational scenarios (Redis
      lock outage, guardrail-gRPC outage, NATS-publish-to-Module-04
      failure, anti-abuse rate-limit tuning/triage, bid-close-sweep
      troubleshooting, migration rollback) with real SQL/metric
      snippets, matching `docs/module-05-runbook.md`'s own format and
      honesty bar - including a prominent, explicit callout of the
      bidding-to-assignment gap (see below).
- [x] ADR-0092 - this phase's own methodology decisions (load-test
      scope/accepted boundaries, dashboard/metric choices) and the
      bidding-to-assignment gap's own explicit write-up.

## Explicitly NOT done here (needs a different owner, a different phase, or was judged disproportionate to this phase's scope)

- [ ] **Sustained-load validation** - Phase 8's load test proved the
      three SLOs at a ~1-second, 1,000-request burst; it does not prove
      the same numbers hold across hours of continuous traffic, nor with
      many *distinct* popular shifts contended simultaneously (each of
      the 25 rounds ran one contended post at a time, sequentially).
- [ ] **Guardrail-latency SLO under a full constraint-check payload** -
      the load test's own accepted scope boundary: every round's post
      carries a non-resolving `shiftAssignmentId`, so the real gRPC
      round-trip measured resolves a fast not-found path, not a full
      eligibility computation. The measured p99 (~100ms) is a floor, not
      a ceiling, on real-world guardrail latency.
- [x] ~~Redis-up gauge, NATS-publish-latency/success metric,
      bid-close-sweep-tick metric~~ - **closed by ADR-0159**:
      `marketplace_redis_up` (set from `MarketplaceRedisService.ping`/
      `acquireClaimLock`), `marketplace_nats_publish_duration_seconds`/
      `marketplace_nats_publish_total` (set from
      `MarketplaceNatsClientService.publish`), and
      `marketplace_bid_close_sweep_ticks_total`/`..._opportunities_total`
      (set from `BidCloseSweepService.sweepTick`) all now exist.
- [ ] **A replay tool for a failed Module 04 NATS publish** - runbook
      §3's manual, by-hand recovery procedure is the only path today.

## Module-wide standing gaps (indexed from every prior phase's own ADR, not re-derived)

- [x] ~~Bidding never reaches a real assignment - the largest functional
      gap in this module.~~ **Closed by ADR-0159.**
      `BidService.closeBidOpportunity` now converts the rank-1 winner
      into a real `MarketplaceClaim` (re-validating eligibility, flipping
      the `MarketplacePost` to `claimed`, notifying scheduling-service via
      the same `ShiftClaimApproved` event `claimOpenShift` uses, now
      carrying a `source: 'bid'` field). `MarketplaceClaim` gained a
      `source` column so `approveMarketplaceAction`'s existing
      `claimId`-only path can still notify Module 04 correctly for a
      bid-derived claim that needed supervisor approval - no new mutation
      or `bidId` parameter was needed. `assignment_source`'s `bid` value
      (reserved since Module 04's 0001 migration) is now actually
      written. Discovered and explicitly flagged at each of Phase 4/7/8
      (see ADR-0092's own write-up) before being closed here.
- [ ] **No real tenant/actor authentication** - `X-Tenant-Id`/
      `X-Actor-Id` are trusted as-is (ADR-0084), the same class of gap
      every sibling service in this platform besides the root app has
      left open. No approver-role check on `approveMarketplaceAction`
      either (ADR-0089) - any bound actor can approve any pending action.
- [ ] **No `graphql-ws` connection-level tenant authentication** -
      `marketplacePostUpdated` (Phase 2) can be subscribed to by any
      client that already knows a `tenantId`/`orgUnitId`, same limitation
      every other service's own subscription surface in this platform
      accepts.
- [ ] **`eligibleForMe` degrades to `false`, silently, for a subscription
      delivery with no bound actor context** (ADR/Phase 2's own
      documented limitation, `MarketplacePostResolver.eligibleForMe`) -
      a known, flagged trade-off, not a bug, but still a real
      client-visible imprecision.
- [ ] **Single-instance GraphQL subscriptions PubSub** - the in-process
      `graphql-subscriptions` backend (Phase 2) means running more than
      one instance of this service does not give working horizontal
      scale for `marketplacePostUpdated` delivery - the same class of gap
      Module 05 named for its own subscription backend (ADR-0068).
- [ ] **Badge/point values are hardcoded, not tenant-configurable**
      (Phase 7, ADR-0091, a deliberate scoping decision, not an oversight)
      - revisit if a real tenant ever asks for different gamification
      economics.
- [ ] **Terraform/Vault, penetration testing, SAST/SBOM** - the same
      explicit non-goals stated platform-wide for every module's early
      phases, restated (not newly discovered) here.

## Summary: what Module 07 actually is, end to end

A concurrency-safe open-shift claim flow (Redis `SET NX`-based
distributed lock, ADR-0085) and a peer-to-peer swap flow (ADR-0087),
both validated through the exact same Module 04 guardrail gRPC call the
solver itself uses (ADR-0082/0086, closing a real cross-service gap this
module's own first phase discovered) - never a parallel eligibility
implementation. A bidding mechanism with real rank transparency across
all three ranking methods (ADR-0088), currently stopping short of an
actual assignment handoff (the module's largest standing gap, above). An
auto-vs-supervisor approval workflow (ADR-0089) that closes the loop to a
real, locked `ShiftAssignment` via scheduling-service's first-ever NATS
consumer - proven with a real, non-mocked end-to-end integration test,
not an assumption. Anti-abuse rate limiting on claim attempts, distinct
from any generic request quota (ADR-0090). A real, auditable, queryable
engagement ledger - points/streaks/badges traceable to the exact action
that earned them (ADR-0091). Proactive observability (a Grafana
dashboard covering every metric this service emits) and a real
popular-shift-contention load test proving all three stated SLOs hold at
burst scale (Phase 8, ADR-0092). Eight phases, eleven ADRs (0082-0092,
starting with the Module 04 eligibility-server ADR that made this
module's own non-negotiable - real guardrail re-validation, never a
parallel implementation - possible at all), one runbook, one dashboard -
the gaps above are the honest, named boundary of what this module does
not yet solve, with bidding's missing assignment handoff the one most
worth prioritizing next.
