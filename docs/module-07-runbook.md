# Module 07 Runbook — Shift Marketplace

Operational reference for `shift-marketplace-service` (Phases 1-8). Every
check below is a direct SQL query against `marketplace.*` (any role with
`SELECT` - `agno_migrator` locally), a `redis-cli` command, or a scrape of
the one `/metrics` endpoint (`GET :8400/metrics`) - see
`observability/grafana-dashboard-module-07.json` for the panelled view of
the same data.

## 0. One process, three real external dependencies

`shift-marketplace-service` (`node dist/src/main.js`) is a single process:
the GraphQL API (`/graphql`, including `graphql-ws` subscriptions),
`BidCloseSweepService`'s `@Cron` sweep, and the two gRPC *clients* (not
servers - this service never hosts a gRPC server itself) all run
in-process. Three real dependencies, each with its own documented failure
posture:

- **Postgres** (`marketplace` schema, RLS via `withTenantConnection` on
  every query, ADR-0083) - `GET /readyz` checks this.
- **Redis** (the claim/swap-response contention lock, ADR-0085) -
  `GET /readyz` checks this. A claim/swap-response attempt while Redis is
  down gets `MarketplaceUnavailableError` (fails closed, never falls back
  to an unlocked write) - see §1 below.
- **scheduling-service's gRPC eligibility server** (port 8102, ADR-0082)
  - the guardrail-validation round-trip every claim/swap/bid submission
    makes. Down or slow: see §2 below.

`platform-core`'s gRPC `EmployeeService` (port 5000) is a *soft*
dependency - only `BidService.closeBidOpportunity`'s seniority-ranking
path (`rankingMethod: seniority`) calls it; `first_come`/`preference_score`
bid opportunities never touch it.

## 1. Redis is down (or claims are all failing with `MARKETPLACE_UNAVAILABLE`)

**Confirm it's real**: `redis-cli -h <host> ping`, or watch for repeated
`"Failed to release claim lock ...: ECONNREFUSED"` / `"Redis PING
failed"` warnings in this service's own logs
(`MarketplaceRedisService`). There is no `/metrics` gauge for Redis
health today (unlike Module 05's `intraday_redis_up` - a real,
named gap, see the Phase 8 checklist) - `/readyz`'s reactive check is
the only synchronous signal.

**What clients see**: every `claimOpenShift`/`respondToSwap` call throws
`MarketplaceUnavailableError` (`503`-mapped) the moment
`MarketplaceRedisService.acquireClaimLock` fails - by design (ADR-0085's
own "fail closed, never fall back to an unlocked DB write"). Read-only
queries (`marketplacePost`, `bid`, `myMarketplaceEngagement`, ...) are
unaffected - they never touch Redis.

**Recovery**: nothing to do manually - the next `claimOpenShift`/
`respondToSwap` call after Redis recovers succeeds normally. No stuck
state to clean up: a claim/swap that failed this way was rejected before
any database row was even created.

## 2. Guardrail validation gRPC (scheduling-service) is down or slow

**Confirm it's real**: `curl :8400/metrics | grep marketplace_guardrail_validation_duration_seconds`
for latency, or check scheduling-service's own `/healthz`
(`:8100/healthz`) and gRPC port (`lsof -i :8102`). This service's own logs
show the underlying gRPC error (connection refused, deadline exceeded)
wrapped as `GuardrailValidationUnavailableError`.

**What clients see** (ADR-0086's own "single Module 04 call, fail closed"
posture): a `claimOpenShift`/`respondToSwap`/`submitBid` in flight when
this happens gets marked `rejected` (claims/swaps) or thrown back
(`submitBid`) with `validationResult: { reason: "guardrail_validation_unavailable" }`
- **never left stuck in `pending_validation`** (the exact "invalid claim
occupying a slot" failure mode §2.2 rule 2 forbids, one status earlier
than the rule names). The post/swap itself is untouched, so it's still
claimable/respondable immediately - no manual cleanup needed.

**Recovery**: nothing to do manually once scheduling-service's gRPC
server is back - retried automatically by the next real attempt.

## 3. NATS publish to Module 04 (`ShiftClaimApproved`/`SwapExecuted`) fails

**Confirm it's real**: grep this service's logs for
`"Failed to publish ShiftClaimApproved for claim ..."` /
`"Failed to publish SwapExecuted for swap ..."`
(`MarketplaceEventPublisherService`, both `logger.warn`, not `error`).
**There is no metric for this** - a real, named gap (Phase 8 checklist) -
today the only record is that one log line.

**What this means operationally**: the claim/swap is already `approved`/
`accepted` in this service's own database (Postgres commit happens
*before* the NATS publish attempt, ADR-0089's "best-effort, not
transactional" design) - the employee-facing state is correct and final.
What's missing is scheduling-service ever hearing about it, so the
underlying `ShiftAssignment` never actually gets reassigned/locked. This
is a silent propagation gap until someone reads the logs - there is no
automated retry and no DLQ on the *publish* side (scheduling-service's
own consumer has a receive-side DLQ, `AGNO_MARKETPLACE_DLQ`, for messages
it fails to *process* - that's a different failure mode from this
service failing to *publish* one at all).

**Recovery (manual, no tooling exists for this)**: identify the affected
`marketplace_claim`/`swap_request` row (`id`, already `approved`/
`accepted` in Postgres), construct the equivalent NATS message by hand
(`agno.marketplace.claim.approved.v1` / `agno.marketplace.swap.executed.v1`,
payload shape in `marketplace-event-publisher.service.ts`), and publish
it directly via `nats pub` or a one-off script. There is no built-in
replay tool.

## 4. Anti-abuse rate limiting (§5.2, Phase 6)

**Check a specific employee's current window**:
```sql
SELECT claim_attempt_count_window, claim_attempt_window_start
FROM marketplace.marketplace_engagement_score
WHERE tenant_id = '<tenant>' AND employee_id = '<employee>';
```
(Requires `SET app.current_tenant_id` first if querying as
`agno_marketplace_app` rather than `agno_migrator` - RLS.)

**Tune the limit** without a deploy for one tenant:
`MARKETPLACE_CLAIM_ATTEMPT_LIMIT_OVERRIDES` (JSON map, restart required -
it's read once at process start, not polled). Defaults: 10 attempts/60s,
env `MARKETPLACE_CLAIM_ATTEMPT_LIMIT`/`MARKETPLACE_CLAIM_ATTEMPT_WINDOW_SECONDS`.

**Distinguish abuse from a real incident**: `curl :8400/metrics | grep 'marketplace_claim_attempts_total{result="rate_limited"'` -
a sustained climb here across many distinct employees at once during a
real popular-shift moment (a real product success, not abuse) vs. a
climb concentrated on one or two employee ids (likely a script) - this
service does not distinguish the two automatically; that judgment call
is a human reading this metric plus `marketplace_claim_attempts_total{result="lock_lost"}`
(legitimate contention) side by side.

## 5. `BidCloseSweepService` (the `@Cron` job) isn't closing opportunities

Runs every minute, cross-tenant (`migratorPoolProvider`, bypasses RLS by
design - it must see every tenant's expired opportunities in one query).
Check this service's own logs for `"Bid close sweep query failed"` /
`"Failed to close bid opportunity ..."` (both `logger.error`, one bid
opportunity's failure never blocks the sweep's other candidates in the
same tick - see `BidCloseSweepService.sweepTick`'s own per-candidate
try/catch), or `marketplace_bid_close_sweep_ticks_total{outcome="query_failed"}`/
`marketplace_bid_close_sweep_opportunities_total{outcome="failed"}`
(ADR-0159 - these metrics didn't exist before this ADR).

**Updated by ADR-0159, no longer accurate as previously written**:
closing a bid opportunity (`BidService.closeBidOpportunity`) now attempts
to convert the rank-1 winner into a real `MarketplaceClaim` -
re-validating eligibility, flipping the `MarketplacePost` to `claimed`,
and (if the tenant doesn't require supervisor approval) notifying
scheduling-service the same way `claimOpenShift` does. This can still
legitimately fail to produce a claim: the winner may fail re-validation,
or the post may no longer be `open` - both are logged
(`BidService`'s own `logger.warn`/`logger.error`) rather than silent, and
in both cases the opportunity still closes with every bidder's rank
transparency intact, just without a resulting claim. Query
`marketplace.marketplace_claim WHERE marketplace_post_id = $1 AND source
= 'bid'` to check whether a specific closed bid opportunity's post
actually got claimed - do not assume a closed opportunity means the
shift is covered without checking.

## 6. Migration rollback

`npm run typeorm -- migration:revert -d src/database/data-source.ts`
reverts the most recent migration only. `1700002000000-MarketplaceEngagementLedgerSchema`'s
`down()` drops `marketplace_engagement_event` and the `last_engagement_date`
column - reverting it after real engagement events have been recorded
**destroys that ledger data**, same standard caveat every other
service's own runbook states for its own down() migrations.

## Known standing gaps (see the Phase 8 checklist for the full list)

- ~~No Redis-up gauge, no NATS-publish-latency/success metric, no
  bid-close-sweep metric~~ - closed by ADR-0159:
  `marketplace_redis_up`, `marketplace_nats_publish_duration_seconds`/
  `marketplace_nats_publish_total`, and
  `marketplace_bid_close_sweep_ticks_total`/`..._opportunities_total` now
  exist and are on the Grafana dashboard.
- No replay tooling for a failed Module 04 NATS publish (§3 above) -
  manual, by hand, no script exists.
- ~~**Bidding never reaches a real assignment**~~ - closed by ADR-0159
  (§5 above): a bid opportunity's rank-1 winner is now converted into a
  real `MarketplaceClaim` on close, same as a first-come claim.
