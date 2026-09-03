# Module 07 — Shift Marketplace: Design Overview

**What this document is, and isn't.** Every other active module in this
repository (02, 03, 04, 05, 06, 08, 09, 10, 12) has a standalone design
doc per phase. Module 07 does not — `docs/module-07-phase-1` through
`-phase-7` design docs were never produced (confirmed absent from both the
working tree and the docs archive; `docs/module-07-phase-8-production-
readiness-checklist.md` says as much explicitly: "Phases 1-7 of this
module did not each produce a standalone checklist file"). This document
is **not** a recovered or reconstructed history — nobody can reconstruct
design intent that was never written down. It's a current-state reference,
assembled from what *does* exist (`docs/adr/0082` through `0092` plus
`0159`, the Phase 8 checklist, the runbook, and the code itself), so a
reader doesn't have to cross-reference eleven ADRs to answer "what is this
module and how did it get here."

## What this module is

The shift marketplace: employees claim open shifts, propose/accept swaps,
and bid on shifts a tenant wants ranked (seniority, preference score, or
first-come). It is Module 04 (scheduling-service)'s *only* consumer-facing
front door for changing who's on a shift after a schedule publishes —
every claim/swap/bid this service approves eventually becomes a real,
locked `ShiftAssignment` row in Module 04, never a parallel source of
truth.

## How the phases built it up (reconstructed from ADRs, not original docs)

| Phase | What it added | Key ADRs |
|---|---|---|
| 1 | `marketplace` schema, `MarketplacePost`/`MarketplaceClaim` DDL | ADR-0083 |
| 2 | The concurrency-safe open-shift claim flow: Redis distributed lock, Module 04's `SchedulingEligibilityService` gRPC guardrail check | ADR-0082, 0084, 0085, 0086 |
| 3 | `SwapRequest` — two-sided guardrail validation, reuses the claim lock | ADR-0087 |
| 4 | `BidOpportunity`/`Bid` — seniority/preference-score/first-come ranking, `BidCloseSweepService`'s `@Cron` close-on-window-end job | ADR-0088 |
| 5 | Tenant auto-approval policy, `approveMarketplaceAction`, `MarketplaceEventPublisherService`, scheduling-service's *first* NATS consumer — closes claims/swaps to a real locked assignment | ADR-0089 |
| 6 | Claim-attempt-specific anti-abuse rate limiting | ADR-0090 |
| 7 | `MarketplaceEngagementService` — points/streaks/badges as a real, auditable ledger | ADR-0091 |
| 8 | Load test, Grafana dashboard, Prometheus scrape entry, the runbook, the one consolidated readiness checklist (this module's docs have never had a per-phase checklist series) | ADR-0092 |
| — | Bid-to-assignment conversion — the gap ADR-0089/0092 explicitly deferred, closed after Phase 8 | ADR-0159 |

## Where things stand today

**Closed, real, and integration-tested:**
- Open-shift claims and swaps → real, locked `ShiftAssignment` rows
  (`tests/integration/test_marketplace_claim_locks_assignment.py` on
  scheduling-service's side, `test/integration/claim-open-shift-concurrency.spec.ts`
  on this side).
- Bid ranking *and* conversion — a closed `BidOpportunity`'s winner is now
  a real `MarketplaceClaim`, same downstream path as an open-shift claim
  (ADR-0159, `test/integration/bid-close.spec.ts`).
- Popular-shift-contention load test proving all three §0.5 SLOs at a
  1,000-request burst (`docs/module-07-phase-8-load-test-results.md`).
- Observability: Grafana dashboard + Prometheus scrape for every metric
  this service emits, including the Redis/NATS/sweep signals ADR-0159
  added.

**Still open** (see `docs/module-07-phase-8-production-readiness-checklist.md`
for the full, current list):
- No real tenant/actor authentication (`X-Tenant-Id`/`X-Actor-Id` are
  trusted as-is, ADR-0084) and no approver-role check on
  `approveMarketplaceAction` — both explicitly deferred to a future
  platform-wide identity phase, not a Module 07-specific gap.
- No `graphql-ws` connection-level tenant authentication on the
  `marketplacePostUpdated` subscription.
- Single-instance in-process GraphQL PubSub — no horizontal scale for
  subscriptions; the same single-instance assumption also means multiple
  `BidCloseSweepService` replicas would race on the same candidate query.
- No replay tooling for a failed Module 04 NATS publish (manual, by hand).
- Sustained (non-burst) load and full-payload guardrail latency remain
  unmeasured — the Phase 8 load test's own accepted scope boundary.
