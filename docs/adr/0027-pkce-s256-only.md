# ADR-0027: PKCE `S256` only, `plain` rejected outright

## Context
OAuth 2.1 (§5.1's mandated standard) folds PKCE (RFC 7636) into the base spec for
every authorization_code grant and explicitly forbids the `plain` code challenge
method - `plain` exists in RFC 7636 only as a fallback for clients that literally
cannot compute SHA-256, which does not describe any client this platform targets
(web, mobile, CLI/device - all have a SHA-256 implementation available).

## Decision
`code_challenge_method` is validated against the literal string `S256` at three
independent layers, deliberately redundant:
1. `AuthorizeRequestDto.code_challenge_method` (`@IsIn(['S256'])`) - rejects a
   non-S256 request before it reaches any service.
2. `PkceService.assertSupportedMethod` - a second, service-level check so the rule
   holds even for a caller that bypasses the DTO (e.g. a future internal caller).
3. `authorization_codes_pkce_s256_only` (DB `CHECK` constraint) - holds even against a
   bug in application code, matching this repo's general posture (§2.2) of treating
   security-critical invariants as database facts, not just application promises.

`PkceService.verify` compares the SHA-256 of the presented `code_verifier` against the
stored `code_challenge` using `crypto.timingSafeEqual`, not `===`, so verification
timing cannot leak how many leading bytes matched.

## Consequences
- A client that only supports `plain` (none exist among this platform's targeted
  client types) cannot use this authorization server at all. Accepted trade-off -
  OAuth 2.1 compliance is a stated requirement (§1), and `plain` is a known-weaker
  mechanism (the challenge equals the verifier, so intercepting the authorization
  request alone is enough to forge a token exchange).
- `code_verifier` format (43-128 chars, `[A-Za-z0-9-._~]`) is validated before the
  timing-safe comparison, both to reject malformed input with a clear error and so a
  clearly-invalid verifier never reaches the constant-time comparison path with
  mismatched buffer lengths in a way that could complicate the timing-safety argument.
