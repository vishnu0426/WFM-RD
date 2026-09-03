# ADR-0025: Refresh token rotation + reuse detection via family_id/generation, Redis as a fast-path cache only

## Context
§3.4 requires "refresh token rotation, reuse triggers full family revocation" and a
"current-valid-token pointer in Redis for fast lookup." §1 forbids Redis as a system
of record. The mechanism has to (a) make a stolen-and-replayed refresh token
detectable, (b) revoke every token derived from that theft the instant it's detected,
and (c) survive a Redis outage without losing correctness (only latency).

## Decision
`core.refresh_tokens` is the source of truth. Every row belongs to a `family_id`
(constant for the life of one "session," starting at first login) and carries a
`generation` (1, 2, 3, ... incrementing on each rotation) and a `status`
(`active`/`rotated`/`revoked`). Rotating token generation N does two things in one
transaction: mark row N `rotated` (via a compare-and-swap `UPDATE ... WHERE status =
'active'`, not a blind update - see `RefreshTokensRepository.rotate`) and insert row
N+1 as `active`. Presenting a token that is not its family's current `active` row -
because it was already rotated, or because two concurrent requests raced to rotate the
same token and one lost - is treated as reuse: the *entire* family is revoked, and the
caller gets `invalid_grant` (RFC 6749), indistinguishable from an ordinary expired
token so an attacker can't use the response to confirm their theft was detected.

Redis caches the current row per token hash (`session:refresh:token:<sha256>`), TTL'd
to the token's own expiry, purely to skip a Postgres round trip on the common case. A
cache miss (cold Redis, eviction, first request after a restart) falls back to the
Postgres CAS directly - correctness never depends on the cache being warm; only
latency does.

## Consequences
- The CAS-loses-the-race path (`RefreshTokensRepository.rotate` returns `null`)
  revokes the family exactly as if reuse were detected, even though a legitimate
  double-submit (a client naively retrying a timed-out request) triggers the same
  fail-closed response. This is a deliberate trade-off: distinguishing "malicious
  replay" from "benign double-submit" would need idempotency-key-style dedup on the
  refresh grant itself, which is out of scope for Phase 2 (§3.2's `Idempotency-Key`
  cross-cutting requirement is Phase 6). A client that retries a *timed-out* refresh
  request risks self-inflicted lockout; a client that waits for a response before
  retrying never hits this.
- Revoked-family rows are never deleted (`agno_app` has `DELETE` grant for a future
  cleanup job, but `RefreshTokenService` itself never calls it) - an incident
  investigation can always see the full rotation history of a compromised session.
- `authorization_codes`/`refresh_tokens` never store the raw code/token, only a SHA-256
  hash - a database dump or a read-replica leak doesn't hand out usable credentials.
