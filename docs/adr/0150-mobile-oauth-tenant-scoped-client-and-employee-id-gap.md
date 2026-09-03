# ADR-0150: Mobile OAuth uses one tenant-scoped seeded client; `employeeId` stays a dev stub because no session -> Employee lookup exists

## Context

Module 11 Phase 2 wires `mobile-app` up to Module 01's already-complete
OAuth2.1 implementation (`src/modules/auth/`) — no new backend token-flow
code was needed. Two real platform limitations surfaced while doing this,
both confirmed by reading the actual source rather than assumed, and both
handled here by naming them, not working around them (the same discipline
ADR-0014/ADR-0076 established elsewhere in this platform):

1. **`OAuthClient.tenantId` is a required column.** `POST /oauth/authorize`
   resolves the entire tenant context from `client.tenantId`
   (`oauth.controller.ts`, `oauth-clients.repository.ts`) before it even
   looks up the user — there is no independent `tenant_id`/`X-Tenant-Id`
   mechanism at that call. One `client_id` can only ever authenticate users
   of the one tenant it was registered under.
2. **No `userId -> Employee` resolution exists anywhere in the API.** The
   access token's `sub` claim is a `core.users.id`. The existing `me`
   GraphQL query (`src/modules/identity/graphql/user.resolver.ts`) returns
   a `User` with no `employeeId` field and no resolve-field bridge to
   `Employee`. `Employee.userId` exists as a column but is only exposed
   outward (`employee(id) { userId }`); there is no reverse lookup, and
   `employees(filter)` isn't filterable by `userId` either. This is
   inherited from Module 02's original build, not a Module 11 defect.

## Decision

**One seeded PUBLIC OAuth client, scoped to the demo tenant.**
`src/database/seeds/run-seed.ts`'s `seedOAuthClients` gained a third entry,
`wfm-mobile-app` (same idempotent pattern as the existing `demo-web-app`),
with `redirectUris: ['agnowfm://oauth/callback']` matching `mobile-app`'s
own `app.config.ts` scheme. That redirect URI is never actually navigated
to — `POST /oauth/authorize` returns the authorization code directly in
its JSON response body (ADR-0026), not via an HTTP redirect — but it's
still exact-string validated as the client's registered identifier on both
`/authorize` and `/token`. Real multi-tenant mobile client provisioning
(one client per tenant? something else?) is out of scope for Module 11 to
solve; it's a Module 01 concern.

**`useCurrentIdentity()`'s `employeeId` stays a dev-only stub.**
`tenantId` now comes from the real, authenticated session's JWT `tenant_id`
claim (`AuthContext`). `employeeId` continues to read
`EXPO_PUBLIC_DEV_EMPLOYEE_ID`, gated on the same
`EXPO_PUBLIC_APP_ENV !== 'production'` check `DevIdentityBanner` already
uses — a production build has no fallback and throws rather than silently
using an undefined dev value in a build where `tenantId` is now
legitimately real. Module 11 does not invent a workaround (e.g. scanning
`employees(filter)` client-side, which isn't filterable by `userId` today
and would need permissions a self-service employee shouldn't have anyway).

**scheduling-service calls now attach `Authorization: Bearer <accessToken>`.**
`GET /v1/scheduling/employees/{employeeId}/shift-assignments` has no auth
guard today — the Phase 1 design doc already flagged revisiting this "once
Phase 2 lands a real token." `apiGet()` (`src/api/client.ts`) attaches the
header via `tokenGateway` regardless — forward-compatible and the correct
client behavior once a real token exists, rather than a two-tier client
where only GraphQL calls carry auth.

**One generic message for every `invalid_grant` on sign-in.**
`InvalidCredentialsError` (bad password) and `AccountLockedError` both
serialize to the identical `{error: 'invalid_grant'}` — only a free-text
`error_description` differs, and string-matching it would be a brittle,
silently-breaking parse if the backend's wording ever changes. `login.tsx`
shows "Incorrect username or password." for any `invalid_grant`, not a
distinct "account locked" message.

**A refresh rejection (`invalid_grant`) always means: discard tokens, sign
out.** Reused (post-rotation) and merely-expired refresh tokens are
deliberately indistinguishable server-side (`RefreshTokenReusedError`
surfaces identically to any other `invalid_grant`, so as not to leak
reuse-detection to a possible attacker) — `tokenGateway.getValidAccessToken()`
treats both the same way: clear the session, notify `AuthContext`, never
retry-loop.

## Consequences

- Adding a second tenant to local/demo data does not get that tenant a
  working mobile sign-in for free — it needs its own `wfm-mobile-app`-
  equivalent `OAuthClient` row. Not automated by this ADR.
- Any screen that needs a real `employeeId` (not just `tenantId`) remains
  blocked on Module 02 adding a `userId -> Employee` lookup. The schedule
  screen (Phase 1) keeps working only because it already depended on the
  dev stub before this phase existed — this ADR doesn't change that
  screen's correctness, only documents why it's not yet fully fixed.
- `tokenGateway.getValidAccessToken()` is the only sanctioned path to an
  access token for any authorized call (`apiGet`, `graphqlRequest`) —
  calling `authClient.refreshTokens()` directly anywhere else would
  reintroduce the concurrent-refresh race this gateway exists to prevent
  (two independent refreshes racing to present the same soon-to-be-rotated
  refresh token, the second of which the server treats as reuse and revokes
  the entire token family).
- `DevIdentityBanner`'s copy now specifically says `employeeId` isn't
  resolved from the session, not "not signed in" — sign-in is real as of
  this phase.
