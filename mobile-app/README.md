# mobile-app

Module 11 (Mobile / Employee Self-Service) — React Native (Expo, managed
workflow) client. This is the first client/frontend of any kind in this
platform; it consumes each owning module's existing GraphQL/REST API
directly, the same way any other client would (docs/adr/0146) — it does
not have or need its own backend business logic.

**Phase 1**: app scaffolding, core navigation, a read-only "my schedule"
screen, and the WCAG 2.1 AA accessibility baseline (docs/adr/0147).
**Phase 2**: real sign-in against Module 01's OAuth2.1 flow, biometric-gated
local unlock (docs/adr/0150). **Phase 3**: offline `clock_event` queueing —
Clock In/Clock Out on the Schedule screen, an encrypted local queue
(`expo-secure-store`, chunked), and sync-on-reconnect against a new backend
service, `mobile-ess-service` (docs/adr/0151, docs/adr/0152). **Phase 4**
(see `docs/module-11-phase-4-design-doc.md`): `leave_request`/
`marketplace_claim` offline sync — new Leave/Marketplace tabs (manual
`leaveTypeId`/`marketplacePostId` entry, no listing endpoint exists yet in
Module 06/07) and a conflict banner generalized across all three action
types (docs/adr/0153). **Phase 5** (see `docs/module-11-phase-5-design-doc.md`):
push notifications — `POST /v1/mobile/devices` (`registerDevice`, called
once per authenticated-session-start) and one real end-to-end delivery
path (a leave request being approved), routed through a real preference
check against Module 01's `NotificationPreference` (docs/adr/0154).
**Phase 6** (see `docs/module-11-phase-6-design-doc.md`): geofencing,
tenant opt-in per org unit — a blocking disclosure card gates location
capture on Clock In/Out, verification happens server-side (never trusts
a client-computed result), out-of-bounds is flagged for supervisor review
by default and only hard-blocked if the tenant explicitly configures hard
enforcement (docs/adr/0155). **Phase 7** (see
`docs/module-11-phase-7-design-doc.md`): Adherence and Hours tabs — pure
read-only visibility, called directly against intraday-service
(Module 05, real-time status), adherence-compliance-service (Module 08,
today's adherence %), and attendance-leave-service (Module 06, hours
worked + leave balances), with no mobile-ess-service indirection since
none of it is gRPC-only (docs/adr/0146). "Hours," not "Pay" — no
payroll/compensation data exists anywhere in this platform (docs/adr/0156).

## Setup

```
cd mobile-app
npm install
cp .env.example .env   # fill in an employee id from your local seed data
npm run web             # or: npm start, then press i/a for iOS/Android
```

Sign in locally with the seeded demo credentials
(`admin@acme-demo.example` / `ChangeMe123!`, see root
`src/database/seeds/run-seed.ts`). `tenantId` now comes from the real
session's JWT claim; `employeeId` is still a dev-only stub
(docs/adr/0149, docs/adr/0150 — there is no `userId -> Employee` lookup
anywhere in the platform API yet) read from `.env`. `EXPO_PUBLIC_*` values
are compiled into the JS bundle, so `.env` must never be set for a
production build — `eas.json`'s `production` profile sets
`EXPO_PUBLIC_APP_ENV=production`, which turns off the on-screen dev-stub
banner and is the flag any later phase should gate real-vs-stub identity on.

The schedule screen calls scheduling-service's
`GET /v1/scheduling/employees/{employeeId}/shift-assignments` directly
(docs/adr/0064) — make sure that service is running locally
(`scheduling-service/README.md`) and reachable at `EXPO_PUBLIC_API_BASE_URL`,
and that platform-core (root `src/`, `npm run start:dev`, port `:3000`) is
running and reachable at `EXPO_PUBLIC_AUTH_API_BASE_URL` for sign-in.
Clock In/Clock Out sync needs `mobile-ess-service` running
(`cd mobile-ess-service && npm run start:dev`, port `:8800`) and reachable
at `EXPO_PUBLIC_MOBILE_ESS_API_BASE_URL`, which in turn needs
attendance-leave-service running with a matching HMAC secret configured on
both sides (`mobile-ess-service/.env.example`'s
`ATTENDANCE_LEAVE_INGESTION_HMAC_SECRETS` must equal attendance-leave-
service's own `ATTENDANCE_WEBHOOK_SECRETS` entry for your tenant).

Push notifications (Phase 5) need `EXPO_PUBLIC_EAS_PROJECT_ID` set to a
real EAS project id (`eas init` against a real Expo account — an external,
account-level prerequisite this repo can't provision for you, docs/adr/0154)
before `getOrRequestPushToken()` can mint a real token; without it,
`useRegisterDeviceOnAuth()` fails loud (logged, swallowed) and the rest of
the app is unaffected.

Geofencing (Phase 6) is inactive by default — the disclosure card never
appears and no location is captured unless a tenant admin creates a
`geofence_boundary` `Policy` row (`POST /v1/policies` on platform-core)
for the signed-in employee's org unit. `mobile-ess-service` needs
`CORE_GRPC_URL` reachable to resolve it (docs/adr/0155).

Adherence/Hours (Phase 7) need three more services reachable directly
from the device/simulator: intraday-service
(`EXPO_PUBLIC_INTRADAY_API_BASE_URL`, port `:8200`),
adherence-compliance-service
(`EXPO_PUBLIC_ADHERENCE_COMPLIANCE_API_BASE_URL`, port `:8500`), and
attendance-leave-service (`EXPO_PUBLIC_ATTENDANCE_LEAVE_API_BASE_URL`,
port `:8300` — the same service Clock In/Out already forwards to via
mobile-ess-service, but this is a separate, direct mobile-app call).

## Commands

```
npm run lint        # eslint, includes eslint-plugin-react-native-a11y
npm run typecheck   # tsc --noEmit
npm test            # jest (jest-expo preset, MSW-mocked network)
```

No iOS/Android simulator is available in every environment this runs in;
`npm run web` is the fastest way to sanity-check UI/navigation changes, but
treat platform-specific behavior (safe areas, native accessibility APIs) as
verified structurally through tests, not through an actual device run,
unless you've confirmed one is available.
