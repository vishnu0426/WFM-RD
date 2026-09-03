# Module 11 Phase 2 Design Doc — Standard Auth + Biometric Unlock

**Status:** Approved for implementation
**Owner:** Mobile / Employee Self-Service pod (Module 11)
**Scope:** Real sign-in against Module 01's OAuth2.1 flow, secure token
storage, proactive/deduped refresh, and biometric-gated local unlock
(source spec §5a). No push (Phase 5), no offline queue (Phase 3+), no
geofencing (Phase 6), no `DeviceRegistration` backend entity yet.

## Problem

Phase 1 shipped a schedule screen running against a hardcoded dev-identity
stub (docs/adr/0149) since real auth didn't exist in the app yet. Phase 2
needs to: (a) implement real sign-in without inventing any new backend auth
surface — Module 01's OAuth2.1 implementation is already complete and
needs zero changes for the token flow itself; (b) store tokens in actual
encrypted device storage, never AsyncStorage, per the source spec's
explicit tech-stack requirement; (c) layer biometric-gated local unlock on
top such that biometric data never leaves the device and never bypasses
real authentication (source spec §5a, non-negotiable); and (d) do all of
this while two real platform gaps — a tenant-scoped OAuth client model,
and no `userId -> Employee` lookup anywhere in the API — remain genuinely
unresolved, in a way that's honest about what's real and what's still
stubbed rather than silently working around either.

## Decision

See docs/adr/0150 for the full reasoning; summarized:
- One new seed entry (`wfm-mobile-app`, PUBLIC OAuth client scoped to the
  demo tenant) — the only backend change in this phase.
- `mobile-app/src/auth/` — `pkce.ts`, `tokenStorage.ts` (expo-secure-store,
  with an explicit non-secure web fallback since expo-secure-store has no
  web implementation at all), `authClient.ts`, `tokenGateway.ts` (the single
  chokepoint for every authorized call — dedupes concurrent refreshes,
  refreshes proactively before expiry), `biometric.ts`, `jwt.ts`,
  `errors.ts`, `AuthContext.tsx` (state machine:
  `bootstrapping | unauthenticated | locked | authenticated`).
- `app/login.tsx`, `app/unlock.tsx` (biometric prompt + "Use password
  instead" fallback, sharing `PasswordSignInForm` with `login.tsx`),
  `app/(tabs)/profile.tsx` (pulled forward from its Phase-1-implied Phase 4
  slot — sign-out and the biometric toggle need a UI surface now), route
  guarding in `app/_layout.tsx` via Expo Router's `Stack.Protected`.
- `useCurrentIdentity()`'s `tenantId` becomes real (JWT claim);
  `employeeId` stays a dev stub (docs/adr/0150, gap #2).

## Blast radius

Additive within `mobile-app/` plus one new idempotent seed entry. No
existing backend endpoint changed behavior. `apiGet()` now sends an
`Authorization` header to scheduling-service, which doesn't check it yet
(harmless, forward-compatible). Root `tsconfig.json` gained an explicit
`include` (bug fix, unrelated to auth logic — see Explicit assumptions).

## Rollback plan

Revert the `mobile-app/src/auth/` directory, the new routes, the
`seedOAuthClients` addition, and the `tsconfig.json`/`apiGet` changes.
Nothing outside `mobile-app/` and one seed function depends on any of this.

## Explicit assumptions (spec was ambiguous or silent here)

1. **`POST /oauth/authorize`/`POST /oauth/token` use JSON bodies**, matching
   this platform's other REST DTOs, not RFC 6749's traditional
   `application/x-www-form-urlencoded` — confirmed by reading the DTOs and
   controller directly, not assumed from the RFC.
2. **A single generic "Incorrect username or password" message for every
   `invalid_grant` on sign-in** (docs/adr/0150) — the server gives no
   machine-readable way to distinguish a locked account from a wrong
   password, and string-matching `error_description` would be a fragile,
   silently-breaking parse.
3. **`tokenGateway`'s proactive-refresh skew is 30 seconds** before the
   access token's real expiry — chosen to comfortably cover the round-trip
   of an authorized call without a hardcoded magic number tied to the
   server's actual TTL (`ACCESS_TOKEN_TTL_SECONDS`), which this client
   doesn't hardcode either (uses whatever `expires_in` the token response
   states).
4. **`biometricUnlockEnabled` is a local-only AsyncStorage preference**,
   not the source spec's `DeviceRegistration.biometric_enrolled` backend
   field — that field doesn't exist until Phase 5 (`registerDevice`). Named
   Phase 2 -> 5 seam, same pattern as the Phase 1 -> 2 identity seam
   (docs/adr/0149).
5. **`disableDeviceFallback: true` on `authenticateAsync()`** — the app's
   own "Use password instead" link is the fallback path (source spec's
   explicit non-dead-end requirement), not the OS's device-passcode prompt,
   to keep "biometric only ever gates a locally-stored token" the sole
   mental model, with no secondary path that could be confused for
   bypassing real authentication.
6. **Found and fixed, while touching root `npm run typecheck` for the new
   seed entry: root `tsconfig.json` had no `include`/`exclude`**, so it
   silently swept every sibling service directory into its compilation
   scope by TypeScript's default behavior. This only surfaced as a real
   failure once `mobile-app/`'s JSX and path aliases existed (the other
   plain-TS sibling services happened to typecheck cleanly by accident,
   resolving against their own local `node_modules`). Scoped root's
   `tsconfig.json` to `src/**/*`, `test/**/*`, `scripts/**/*` — what it
   actually owns. Unrelated to auth, but a real latent bug closed while in
   the area, not left for a future PR to trip over.
7. **`app/(tabs)/profile.tsx` is added in this phase**, not Phase 4 as
   Phase 1's `(tabs)/_layout.tsx` comment implied — Phase 2 concretely
   needs a UI surface for sign-out and the biometric toggle. The comment
   was updated to say so explicitly rather than left to go stale.

## Out of scope for this phase (do not build yet)

- Resolving either of docs/adr/0150's two named gaps (multi-tenant client
  provisioning, `userId -> Employee` lookup) — documented, not solved.
- `DeviceRegistration`/`registerDevice`/real backend biometric-enrollment
  tracking (Phase 5).
- WebAuthn login (`webauthn_session_token` path) — already wired
  server-side, but Phase 2 only needed the password branch to satisfy
  "standard auth."
- Offline queue, encrypted-storage reuse for the schedule cache, geofencing,
  leave/marketplace screens (Phase 3/4/6, per Phase 1's doc).
