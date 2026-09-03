# ADR-0091: engagement points/streaks/badges as a real ledger, scoped to verified completions only

## Context
§2.2 rule 3's own instruction, restated by `MarketplaceEngagementScore`'s
Phase 1 doc comment: "a real, queryable, auditable entity - not a
frontend-computed number... every individual point/badge/streak *change*
must be traceable to which action earned it and when." Phase 1 shipped the
running-totals columns (`points`/`streak_days`/`badges`) plus the Phase 6
rate-limit columns on the same row, but deliberately left the actual
points/streak/badge *logic* - and the ledger that traceability requires -
unbuilt until this phase.

## Decision

**A new append-only `marketplace_engagement_event` table** (migration
`1700002000000`, a new file rather than an amendment to
`InitialMarketplaceSchema` - that migration has already run against every
environment this module has touched by this point). Mirrors
attendance-leave-service's `attendance_ingestion_event` shape most closely
among this platform's existing ledgers: plain single-table, not
partitioned (this table's volume is bounded by real marketplace
completions, nowhere near `core.audit_log`/`intraday.adherence_event`
scale), `GRANT SELECT, INSERT` only - append-only enforced by grant, not
by RLS (RLS's own `tenant_isolation` policy shape is identical either
way). `reference_id` (the triggering `MarketplaceClaim`/`SwapRequest`)
stays a plain `uuid`, no `REFERENCES` - it's polymorphic across two
different marketplace tables depending on `event_type`, so a single FK
doesn't fit even though both are same-schema.

**Only `MarketplaceClaimStatus.APPROVED` and `SwapRequestStatus.ACCEPTED`
are real engagement triggers.** Both are the exact moments
`MarketplaceEventPublisherService` already fires the real Module 04
handoff (ADR-0089) - reusing those same four call sites
(`ClaimOpenShiftService`/`SwapRequestService`'s own auto-approval
branches, `ApproveMarketplaceActionService`'s two supervisor-approval
branches) means engagement can never fire for a claim/swap that never
actually became a real, locked assignment. **A bid's winner is
deliberately excluded** - `BidService.closeBidOpportunity` only computes
rank transparency (§5.1/Phase 4); ADR-0089 never extended the actual
Module 04 handoff to bidding, so there is no real "this shift got filled
via a winning bid" completion signal to gamify yet. Inventing a `bid_won`
engagement event over that incomplete flow would reward something that
isn't verified to have happened - flagged here, not silently worked
around, for whichever future phase closes bidding's own missing handoff.

**Both swap participants earn points**, not just the initiator - a swap
is two employees each giving up and picking up a shift; `SwapRequestService`/
`ApproveMarketplaceActionService` each call `MarketplaceEngagementService.
recordEvent` twice, once per employee id, same referenceId (the swap
itself) on both ledger rows.

**Points per event type are a flat, global env default**
(`MARKETPLACE_POINTS_CLAIM_APPROVED=10`, `MARKETPLACE_POINTS_SWAP_EXECUTED=5`)
- unlike claim-attempt limits or auto-approval, nothing in this module's
prompt asks for per-tenant point tuning, so no override map was built for
a configurability requirement nobody stated.

**Badge rules are a small, fixed, hardcoded set** - not tenant-
configurable, same reasoning:
- `first_fill` / `team_player`: awarded once, the first time an employee
  ever reaches a `claim_approved`/`swap_executed` event respectively - free
  from `awardBadges`'s own set-membership check, no separate first-time
  counter needed.
- `week_streak` (7 consecutive days) / `month_streak` (30 consecutive
  days).
- `century_club` (100 lifetime points) / `marketplace_champion` (500).

**Streak continuity is computed from a new `last_engagement_date` column**
on the existing `marketplace_engagement_score` row (UTC calendar date,
this platform's own no-per-tenant-timezone-concept placeholder posture) -
same day as the last event: streak unchanged; exactly one day later:
`+1`; any larger gap: reset to `1`. Storing this one column avoids
re-deriving "was yesterday a qualifying day" from a full ledger scan on
every write.

**`SELECT ... FOR UPDATE` inside the same transaction as the UPDATE and
the ledger INSERT** - two genuinely concurrent completions for the same
employee (different claims/swaps, approved by different supervisors at
the same moment) must never both compute their new totals off the same
stale snapshot. Unlike `ClaimAttemptRateLimiterService`'s pure-SQL atomic
upsert, badge-set-membership logic doesn't reduce to one CASE expression,
so this path takes the row lock instead.

**Read access is a new `MarketplaceEngagementQueryService` + two GraphQL
queries (`myMarketplaceEngagement`/`myMarketplaceEngagementEvents`)**,
always the bound actor's own standing - never an arbitrary `employeeId`
argument, the same context-bound-actor posture every mutation in this
service already takes (ADR-0084). No supervisor-views-a-report's-score
surface exists yet; that's a real RBAC concern this platform doesn't have
anywhere, not invented as a one-off here.

## Consequences
- Verified against real, RLS-protected Postgres
  (`test/integration/marketplace-engagement.spec.ts`): a real ledger row
  per event, real cross-tenant isolation for the same employee id, and -
  the property a mock cannot prove - two genuinely concurrent writes to
  the same employee's score both land correctly (no lost update) because
  of the real `FOR UPDATE` lock.
- `MarketplaceEngagementScore`'s two logically distinct concerns - Phase
  6's abuse counter (`claim_attempt_count_window`/`claim_attempt_window_start`)
  and this phase's gamification ledger (`points`/`streak_days`/`badges`/
  `last_engagement_date`) - share one physical row but never one code
  path; each phase's service only ever touches its own columns.
- Bidding's missing bid-to-assignment handoff (and therefore its missing
  engagement trigger) remains an open, explicitly-flagged gap, tracked
  here and in `MarketplaceEngagementService`'s own doc comment for
  whichever future phase closes it.
