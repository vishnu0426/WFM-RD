# Module 11 Phase 5 Design Doc — Push Notifications

**Status:** Approved for implementation
**Owner:** Mobile / Employee Self-Service pod (Module 11)
**Scope:** `POST /v1/mobile/devices` (`registerDevice`, source spec §3.1)
working end to end, plus one real, complete push-delivery path (a leave
request being approved) proving registration → preference check → send
→ dead-token cleanup actually works. No schema change to
`OfflineActionQueue` — a new table, `DeviceRegistration`, is this phase's
only migration.

## Problem

Phase 5's spec instruction — "`registerDevice`, wiring into Module 01's
existing notification center" — assumes a dispatcher that, on inspection,
doesn't exist. `src/modules/notification/` is a preferences table
(`NotificationPreference`) with a read-only repository; nothing in this
repo has ever sent an email, SMS, or push. The one place that comes
close, `skill-decay-job.service.ts`, only logs who *would* be notified,
with its own comment stating no delivery mechanism exists yet. Phase 5
therefore had to answer a harder question than "wire this up": what is
the smallest real, defensible slice that proves push notifications
actually work, without silently growing into "build Module 01's
notification dispatcher" as an uncredited side effect of a thin mobile
client module?

## Decision

See docs/adr/0154 for full reasoning; summarized:

- `DeviceRegistration` (id, tenantId, employeeId, deviceType, pushToken,
  appVersion, biometricEnrolled, active, lastActiveAt, createdAt) added
  to `mobile-ess-service`'s own `mobile_ess` schema. `POST /v1/mobile/devices`
  (REST, not GraphQL — same call ADR-0151 already made for
  `syncOfflineActions`), guarded by the same `AccessTokenGuard`+
  `TenantTokenMatchGuard` pair every other endpoint in this service uses.
  Upsert keyed on `(tenant_id, employee_id, device_type)` — the spec's own
  DDL has no device-identifier column, so this is the only key it
  supports (a second same-platform device silently displaces the first's
  token — a named, deliberate scope cut).
- `biometricEnrolled` is the real backend home for `mobile-app/src/auth/biometric.ts`'s
  already-documented Phase 2 → 5 seam (`isBiometricUnlockEnabled()`).
- Exactly one event wired end to end: `agno.leave.request.approved.v1`
  (attendance-leave-service), already published, already explicitly
  earmarked in its own doc comment for "Module 01's notification pipeline
  - neither consumer is built in this repo yet." Required
  `mobile-ess-service`'s first NATS wiring (a direct copy of
  `intraday-service`'s `NatsClientService`/`DurableJetStreamConsumer`
  pattern) — a new *consumer* of an already-provisioned stream, not a new
  stream.
- Before sending, a real preference check: a new inbound gRPC RPC on
  platform-core, `NotificationPreferenceService.IsPushEnabled`, extending
  the same inbound-gRPC direction `PolicyGrpcController`/
  `EmployeeGrpcController` already establish (not a new direction).
  Resolves `employeeId -> userId` in-process (nothing else needs this as
  its own RPC yet) and checks `NotificationPreference`'s `PUSH` channel.
  Defaults to **enabled** when no preference row exists — the repository
  is read-only platform-wide, so an opt-in default would make the feature
  permanently unreachable for everyone.
- Delivery via Expo's push API (`ExpoPushClient`) — plain HTTPS, no
  APNs/FCM credentials on this service (Expo managed workflow). Never
  trusts bare `response.ok`; always reads the per-ticket `status`. Only
  `DeviceNotRegistered` triggers dead-token cleanup (`DeviceRegistration.active = false`,
  soft, no DELETE grant — matches `offline_action_queue`'s own
  never-hard-delete posture).
- New metrics (`mobile_push_delivery_attempts_total{outcome}`,
  `mobile_push_dead_token_total`) — the actual §0.5 on-call deliverable;
  an external Prometheus/Alertmanager rule thresholds on these, not built
  here.
- Mobile app: `expo-notifications` installed, config plugin added,
  `useRegisterDeviceOnAuth()` mounted in `(tabs)/_layout.tsx` (fires once
  per authenticated-session-start, upsert-safe to call repeatedly),
  `useNotificationListeners()` mounted at `RootLayout` (not gated on
  auth). A missing/denied permission or an unset EAS project id fails
  closed and silently (logged, swallowed) — never blocks using the app.

## Blast radius

Additive: `mobile-ess-service` (`src/devices/`, `src/nats/`, `src/grpc/`,
`src/push/`, one migration), root platform-core (`src/grpc/proto/notification.proto`,
one new controller, two-line `grpc.module.ts`/`main.ts` edits),
`mobile-app` (`src/notifications/`, one config-plugin entry, two new
dependencies — `expo-notifications`, `expo-constants`). No existing
endpoint in any service changed behavior.

## Rollback plan

Revert `DevicesModule`/`PushModule` and their migration in
`mobile-ess-service`; revert `NotificationPreferenceGrpcController` and
its `GrpcModule`/`main.ts` wiring in platform-core (root gRPC surface
otherwise untouched); revert `mobile-app`'s `src/notifications/` and its
two mount points (`app/_layout.tsx`, `app/(tabs)/_layout.tsx`). No other
phase's data or behavior depends on any of this.

## Explicit assumptions (spec was ambiguous or silent here)

1. **Module 01's "notification center" is a preferences table, not a
   dispatcher.** Named plainly rather than pretended-around — this phase
   builds a narrow, real, single-event slice, not the general system the
   spec's phrasing implies already exists.
2. **Upsert key `(tenant, employee, device_type)`, no `device_id` column** —
   the spec's literal DDL taken over the mobile app's own existing
   per-install id (`src/lib/deviceId.ts`). A second same-platform device
   silently overwrites the first's token; disclosed, not fixed.
3. **`employeeId -> userId` resolved inline inside the new gRPC
   controller**, not exposed as its own RPC — nothing else in the
   platform needs that lookup yet; a dedicated resolver would be
   speculative generality.
4. **Enabled-by-default when no `NotificationPreference` row exists** —
   tied directly to that repository being read-only platform-wide today
   (nothing writes a row, ever, anywhere).
5. **Quiet-hours not enforced.** Columns exist, read, but ignored by
   `IsPushEnabled` — needs a timezone source that doesn't exist anywhere
   in the platform (tenant's? employee's?) and a defer-vs-drop delivery
   decision, a real second feature.
6. **Only `agno.leave.request.approved.v1` wired this phase.**
   Marketplace's `CLAIM_APPROVED`/`SWAP_EXECUTED` explicitly deferred —
   their own doc comment names scheduling-service as their only current
   subscriber (ADR-0089), a bigger conceptual claim to extend than
   leave's already-notification-earmarked event.
7. **No deep-link routing on notification tap** — `notificationListeners.ts`'s
   response listener is a deliberate no-op, OS notification UI only.
8. **EAS `projectId` not provisioned** — `getExpoPushTokenAsync()`
   requires a real EAS project (`eas init`), an external, account-level
   action this repo's code cannot perform for itself.
   `EXPO_PUBLIC_EAS_PROJECT_ID` is plumbed for; `pushToken.ts` fails loud
   with a named error when it's unset.
9. **A per-device Expo send failure never naks the whole NATS event** —
   only the gRPC preference-check failure does (a single per-event call,
   made before anything is sent, so redelivery on failure is risk-free).
   Letting a per-device Expo failure nak the event would duplicate-send to
   any of the same employee's other devices that already succeeded.

## Out of scope for this phase

- A general multi-event, multi-channel notification dispatcher in
  Module 01 — this phase proves one real slice, not the whole system.
- Marketplace `CLAIM_APPROVED`/`SWAP_EXECUTED` (or any other event type)
  as a push trigger.
- EMAIL/SMS/IN_APP channels.
- Quiet-hours enforcement.
- A preference-management UI (`NotificationPreferencesRepository` stays
  read-only).
- Deep-link routing on notification tap.
- Provisioning a real EAS project/account.
- Building the Prometheus alert rule for the new metrics (emitting them
  is in scope; alerting on them is ops config, same as every other
  service).
- True multi-device-per-platform support (no `device_id` column).
- `DeviceRegistration.geofenceVerified`-adjacent work — geofencing is
  Phase 6.

## Verification

- `cd mobile-ess-service && npm run lint && npm run typecheck && npm test`
  — 64 tests: new device-registration (upsert/reactivate/race-recovery),
  NATS consumer (`handlePayload` mirrors `schedule-published.consumer.spec.ts`'s
  pattern), gRPC preference client, Expo push client (transport-level,
  including the never-trust-`response.ok` discipline and the
  `DeviceNotRegistered` dead-token signal), and `PushDispatchService`
  (skip/send/dead-token/per-device-failure-doesn't-propagate/gRPC-failure-
  does-propagate).
- `npm run typecheck` (root platform-core) — new proto/controller compiles
  cleanly; `test/unit/notification-preference-grpc.controller.spec.ts` (6
  tests) covers found+enabled, found+disabled, no row, no linked user.
- `cd mobile-app && npm run lint && npm run typecheck && npm test` — 43
  tests: new `registerDevice`/`useRegisterDeviceOnAuth` coverage using an
  explicit, narrow `expo-notifications` test mock (verified before
  writing tests against it that no jest-expo auto-mock exists for this
  module at all — the same class of gap that silently broke
  `expo-crypto`'s `randomUUID()` in Phase 4).
- `npx expo export --platform web` (mobile-app) — end-to-end bundle smoke
  test confirming the new notification registration/listener wiring
  doesn't break the app shell.
- Manual local run against real NATS + a running attendance-leave-service
  + a real EAS project + a real device: not performed in this environment
  (no persistent multi-service runtime here, no real Expo account) —
  stated plainly rather than claimed, same as every prior phase.
