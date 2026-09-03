# Module 11 Phase 1 Design Doc — App Scaffolding + Accessibility Baseline

**Status:** Approved for implementation
**Owner:** Mobile / Employee Self-Service pod (Module 11)
**Scope:** `mobile-app/` — a standalone Expo (managed, TypeScript) app: core
navigation, a read-only "my upcoming schedule" screen, and the WCAG 2.1 AA
accessibility baseline. No auth (Phase 2), no offline queue (Phase 3+), no
push (Phase 5), no geofencing (Phase 6), no backend changes of any kind.

## Problem

Module 11 needs a mobile client that: (a) is the platform's first client of
any kind — there is no existing RN/testing/accessibility tooling anywhere in
this repo to extend, every package choice here is green-field; (b) proves
out the "no parallel mobile API" principle (§0.8/§8 of the source spec) on a
real screen rather than as an abstract rule, by consuming an owning module's
actual existing API; and (c) treats accessibility (§5c) as a first-sprint
requirement — every screen built in this phase must meet WCAG 2.1 AA from
the start, not as a later retrofit.

## Decision

`mobile-app/` at the repo root, a fully standalone Expo TypeScript package —
consistent with the repo's existing pattern where every service is its own
independent directory with its own toolchain (there is no monorepo tool
anywhere in this repo: no turborepo/nx/pnpm-workspace/lerna). Expo Router
for file-based navigation.

The schedule screen calls scheduling-service's
`GET /v1/scheduling/employees/{employeeId}/shift-assignments` directly
(added Module 05 Phase 2, docs/adr/0064) — there is no GraphQL query for
"an employee's own shift assignments" anywhere in the platform yet, and this
REST endpoint is the actual existing surface. See docs/adr/0146.

Identity for this phase is a hardcoded dev stub (`useCurrentIdentity`),
since real auth is Phase 2 in the source spec's own ordering — a schedule
screen necessarily has to run before login exists. See docs/adr/0149.

Accessibility target is WCAG 2.1 AA, enforced by a combination of shared
components (`Touchable`/`Button` enforcing minimum hit targets), a
contrast-checked color token file, and `eslint-plugin-react-native-a11y` in
CI. See docs/adr/0147.

## Blast radius

Fully additive — a new top-level directory with no dependency on, or from,
any existing service. Nothing in scheduling-service or elsewhere changed;
the endpoint Phase 1 consumes already existed and is unmodified. The only
change outside `mobile-app/` is a new, isolated `mobile-app` job appended to
`.github/workflows/ci.yml` (own `working-directory`, own toolchain) — it
cannot affect the pass/fail outcome of any other job.

## Rollback plan

Delete `mobile-app/` and the `mobile-app` CI job. Nothing else in the
platform references either.

## Explicit assumptions (spec was ambiguous or silent here)

1. **"Shared GraphQL BFF" means "consume each owning module's real API,
   GraphQL or REST, not a parallel mobile API" — not a literal single
   gateway service.** There is no unified GraphQL BFF anywhere in this
   platform; every module (including this one) exposes its own independent
   API. See docs/adr/0146.
2. **Schedule data has no shift name/code today — only timestamps and
   flags.** `EmployeeShiftAssignmentResponse` (scheduling-service) returns
   `shiftStart`/`shiftEnd`/`skillId`/`assignmentSource`/`isOvertime`/
   `locked`/`publishedAt`, nothing else. The UI is built against this real
   shape, not a richer one that doesn't exist yet.
3. **The fetch/cache window is bounded to 14 days ahead**
   (`WINDOW_DAYS_AHEAD` in `useEmployeeShiftAssignments.ts`), to avoid an
   unbounded request as more of an employee's schedule gets published over
   time. Revisit if a real product requirement for a longer visible window
   emerges.
4. **The mobile client sending a self-asserted `X-Tenant-Id` is the same
   standing repo-wide trust gap every other backend-to-backend caller
   already has (ADR-0014's placeholder), not a new one introduced here.**
   ai-layer-service and integration-hub-service have since closed this gap
   for their own GraphQL surfaces with real JWT verification
   (ADR-0130/ADR-0145's precedent) — Module 11 doesn't repeat that closure
   in Phase 1, since Phase 1 has no auth at all yet (Phase 2). Worth
   revisiting once Phase 2 lands a real token.
5. **React Query's cache is persisted to plain `AsyncStorage`, not
   encrypted storage.** Acceptable here since cached shift timestamps
   aren't sensitive the way auth tokens are. Phase 3 introduces encrypted
   storage for the offline action queue and may absorb this cache too, but
   that's not a Phase 1 blocker.
6. **`app/(tabs)/index.tsx` (not `schedule.tsx`) hosts the Schedule
   screen**, so the app's root URL (`/`) resolves directly to it as the only
   tab, rather than requiring an extra redirect route.

## Out of scope for this phase (do not build yet)

- Real OAuth login and biometric unlock (Phase 2) — though Module 01's
  OAuth2.1 implementation already supports a native/public client with zero
  backend changes needed when that phase starts (`OAuthClientType.PUBLIC`,
  PKCE-required `authorization_code` + refresh rotation).
- Offline action queue, encrypted storage, `mobile-ess-service` backend,
  `DeviceRegistration`/`OfflineActionQueue` schema (Phase 3+).
- Push notifications / `registerDevice` (Phase 5).
- Geofencing (Phase 6).
- Leave/marketplace screens and additional tabs (Phase 4) — deliberately
  not stubbed out ahead of time.
- Any new backend endpoint of any kind, in this or any other service.
