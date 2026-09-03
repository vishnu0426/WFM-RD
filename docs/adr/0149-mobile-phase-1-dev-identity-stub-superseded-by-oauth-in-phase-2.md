# ADR-0149: Phase 1's identity is a hardcoded, EAS-profile-scoped dev stub, explicitly superseded by real OAuth-derived identity in Phase 2

## Context

The source spec's own phase ordering puts "core navigation, schedule-
viewing screen" in Phase 1 and "standard auth + biometric unlock" in
Phase 2 — meaning the schedule screen necessarily has to exist and run
before real login does. Module 01's OAuth2.1 implementation
(`src/modules/auth/`) already has everything Phase 2 will need (a
`PUBLIC` OAuth client type specifically for native/mobile apps, mandatory
PKCE, refresh token rotation) — it's simply not wired up yet in this phase.

Something has to stand in for "which employee/tenant is this" in the
meantime, and it needs to be impossible to mistake for real authentication
once it's shipped anywhere.

## Decision

`useCurrentIdentity()` (`src/identity/useCurrentIdentity.ts`) reads
`EXPO_PUBLIC_DEV_EMPLOYEE_ID`/`EXPO_PUBLIC_DEV_TENANT_ID`/
`EXPO_PUBLIC_API_BASE_URL` from Expo environment variables and throws if any
are missing — it is the *only* place in the app that knows about this stub;
every screen/hook downstream calls it rather than reading `process.env`
directly, so Phase 2 replacing it with real OAuth-derived identity is a
single-file change.

Because Expo's `EXPO_PUBLIC_*` variables are compiled directly into the
JS bundle (not injected at runtime), this is scoped to non-production EAS
build profiles only: `eas.json`'s `development`/`preview` profiles set
`EXPO_PUBLIC_APP_ENV` accordingly, while the `production` profile sets it
to `"production"`. A visible `DevIdentityBanner`
(`src/identity/DevIdentityBanner.tsx`) renders on every screen in every
non-production profile, so a hardcoded employee/tenant id can never be
silently mistaken for a real signed-in session — cheap to add now, the kind
of thing that's awkward to retrofit once it's "just how the app looks."

## Consequences

- No production build can function without Phase 2 landing first — a
  production EAS profile has no dev identity to fall back to, by design
  (`useCurrentIdentity()` throws), so there's no risk of accidentally
  shipping the stub to a real user.
- The mobile client sending a self-asserted `X-Tenant-Id`/employee id is the
  same standing trust gap every other backend-to-backend caller in this
  platform already has (ADR-0014's placeholder) — this ADR doesn't close
  that gap, it just makes explicit that Phase 1 inherits it rather than
  introducing a new one.
- Phase 2 must delete `useCurrentIdentity`'s stub implementation (and
  `DevIdentityBanner`) as part of wiring up real auth, not leave it as a
  permanently-dead code path — tracked here as the ADR this repo's
  convention (e.g. ADR-0014) uses to mark a decision as intentionally
  temporary and superseded on a specific, named trigger.
