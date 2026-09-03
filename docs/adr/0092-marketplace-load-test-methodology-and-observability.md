# ADR-0092: popular-shift-contention load test methodology, dashboard scope, and the bidding-to-assignment gap made explicit

## Context
§0.5/§7's own final-phase instruction: "load testing, observability, ADRs,
production readiness checklist - including the §5.1/§5.2 flagged items
and the Module 04 assignment-locking integration test as literal
checklist items, plus the popular-shift contention load test from §0.5
as a release-gate artifact." The §5.1/§5.2 items (bid ranking
transparency, anti-abuse rate limiting) and the Module 04
assignment-locking integration test were already built and proven in
Phases 4/6/5 respectively (ADR-0088/0090/0089) - this phase's own new
work is the load test itself, the observability artifacts, and the
consolidated readiness checklist that indexes every gap named across the
module's prior ten ADRs rather than re-discovering them.

## Decision

**Load test methodology**: a hand-rolled `scripts/load-test.ts`, no new
npm dependency - `fetch`, `graphql-ws` (already a dependency for this
service's own subscription resolver), and Node 22+'s global `WebSocket`
(no separate `ws` package needed, unlike Module 05's own load test which
predates that global). Same "standalone script, real local infra, not
mocked" precedent as `scheduling-service/scripts/load_test_decomposition.py`
and `intraday-service/scripts/load-test.ts` (ADR-0071) - this run used a
real booted `shift-marketplace-service`, a real booted
`scheduling-service` gRPC eligibility server, and real Postgres/Redis.

**Scenario**: 25 independent "popular shift" rounds, each seeding one
fresh `MarketplacePost` directly via the migrator connection (bypassing
the API for setup only, same precedent as Module 05's own queue-seeding
step) and firing 40 concurrent `claimOpenShift` mutations at it - the
literal §0.5 scenario, "many employees racing to claim the same open
shift at once," at 2x the scale of
`test/integration/claim-open-shift-concurrency.spec.ts`'s own N=20.

**Accepted scope boundary, stated up front**: each round's post carries a
random, non-resolving `shiftAssignmentId` - standing up a real
schedule/employee/assignment fixture cross-service for every one of the
25 rounds was judged disproportionate to what this load test needs to
prove. The guardrail gRPC round-trip is still fully real (a genuine
network call to scheduling-service's real gRPC server, ADR-0082); it
resolves `shiftAssignmentFound: false` (a real, fast not-found path)
rather than a full eligibility computation. This still exercises the
winner's complete real pipeline - the lock, the real gRPC round-trip, the
claim ending `rejected`/`stale_post`, the post flipping to `expired`, and
a real `marketplacePostUpdated` subscription push - only the eligibility
*computation* itself is a short-circuit. The measured guardrail p99 is
therefore reported as a floor, not a ceiling, on real-world latency
(`docs/module-07-phase-8-load-test-results.md`'s own Interpretation
section).

**Dual measurement, same posture as ADR-0071**: for the two SLOs this
service already has real Prometheus histograms for (claim lock
acquisition, guardrail validation, subscription push -
`MetricsService`'s own pre-existing doc comments), the load test reports
*both* the client-observed round-trip time (which the SLO is not
strictly defined against, but which is what a real caller experiences)
and the real server-side histogram buckets scraped from `/metrics`
before/after the run (which the SLO *is* defined against). The two
numbers diverge meaningfully for lock acquisition (client p99 79.8ms vs.
server-side p99 ~2.5ms) and subscription push (client p99 127.5ms vs.
server-side p99 <10ms) - both gaps are attributable to real network/HTTP/
event-loop overhead the server-side metric correctly excludes, not a
measurement error, and the results doc says so explicitly rather than
picking one number and hiding the other.

**Dashboard scope** (`observability/grafana-dashboard-module-07.json`):
one panel pair per SLO (the histogram itself plus a related counter/
comparison panel), a process-health row, and an explicit markdown panel
naming what has no continuous metric (the NATS-publish-to-Module-04
path) - same "no silently missing panel" posture Module 05's own
dashboard takes for its own analogous gap. Wired into `docker-compose.yml`'s
`grafana` service with its own mount line - module-05/06's own dashboard
JSON files were discovered to have no such mount line at all (a
pre-existing gap in those modules), left alone here since fixing another
module's own observability wiring is not this phase's scope.

**The bidding-to-assignment gap is written up explicitly, not
implemented.** Reading `BidService.closeBidOpportunity` (Phase 4) plus
`approveMarketplaceAction`'s actual accepted arguments (Phase 5,
ADR-0089) while writing this phase's runbook surfaced that no code path
anywhere in this service turns a winning bid into a real claim or
assignment - `closeBidOpportunity` only persists rank transparency, and
`approveMarketplaceAction` has no `bidId` parameter to accept. This is
larger in scope than any gap this module has closed directly at Phase 6/7
(the claim-attempt-limit env var, the engagement ledger) - building a
real "convert winning bid to assignment" mutation would mean a new
mutation, new guardrail re-validation at conversion time (the bid's own
eligibility check ran at submission time, potentially stale by close
time), a new NATS event variant, and a new engagement-trigger decision -
essentially a Phase 4.5 feature addition, not a Phase 8 documentation/
load-test task. Consistent with this module's own established practice
of surfacing a foundational gap explicitly rather than silently building
around it or silently ignoring it (the original Module 04 eligibility-gRPC
gap took the same path, via an explicit user decision before Phase 1
began) - this one is named prominently in the runbook and the Phase 8
checklist's "Module-wide standing gaps" section as this module's single
most consequential open item, for a human to decide whether and when to
commission the follow-up work.

## Consequences
- The load test is a real, repeatable release-gate artifact
  (`npm run` via `ts-node -r tsconfig-paths/register scripts/load-test.ts
  [claimantsPerRound] [rounds]`) - re-running it after a future change to
  the claim path re-generates `docs/module-07-phase-8-load-test-results.md`
  in place, the same "living artifact, not a one-time snapshot" posture
  Module 05's own load test takes.
- All three §0.5 SLOs are proven met at this run's scale, with large
  margin (lock acquisition ~40x under target, guardrail ~5x under target
  even at its accepted not-found-path floor, subscription push
  comfortably under target on both readings) - see the results doc's
  Interpretation section for the full numbers and what this run does not
  prove (sustained load, many simultaneously-contended distinct shifts,
  full-payload guardrail latency).
- The production readiness checklist (`docs/module-07-phase-8-production-readiness-checklist.md`)
  is this module's first single self-contained readiness document, not a
  final entry in a per-phase series like Module 05's - a deliberate
  choice given Phases 1-7 never produced their own standalone checklist
  files; every real gap those phases' own ADRs already named is indexed
  there rather than re-derived from scratch.
