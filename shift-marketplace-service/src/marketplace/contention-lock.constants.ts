/**
 * Shared by every "exactly one concurrent winner" race this module
 * protects with `MarketplaceRedisService.acquireClaimLock`/
 * `releaseClaimLock` - originally just the open-shift claim (§4 step 1),
 * now also the open-swap-accept race (ADR-0087). Long enough to cover the
 * guardrail-validation pipeline (bounded at 3000ms by
 * `SchedulingEligibilityGrpcClientService`'s own timeout, ADR-0082's
 * ~2.1s worst-case retry budget included) with real margin, short enough
 * that a crashed request doesn't block the contested resource
 * indefinitely if the best-effort release never runs at all. See
 * ADR-0085 for the full algorithm/TTL rationale.
 */
export const CONTENTION_LOCK_TTL_SECONDS = 5;
