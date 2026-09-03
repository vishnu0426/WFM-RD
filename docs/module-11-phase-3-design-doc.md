# Module 11 Phase 3 Design Doc — Offline Action Queue, Core Path (clock_event)

**Status:** Approved for implementation
**Owner:** Mobile / Employee Self-Service pod (Module 11)
**Scope:** `OfflineActionQueue` schema (`mobile-ess-service`, a new backend
service), encrypted local storage (`mobile-app`), and `clock_event` working
end to end: queue while offline → sync on reconnect → real Module 06
ingestion, with `created_at_device` threaded through unchanged. No
`leave_request`/`marketplace_claim` processing (Phase 4), no
`DeviceRegistration`/`registerDevice` (Phase 5), no geofencing (Phase 6).

## Problem

This is the module's actual engineering risk (per the source spec's own
framing): offline-sync correctness, not architecture. Two non-negotiables
had to hold end to end, not just in the schema: `created_at_device` is set
once client-side and is never overwritten by sync time; a sync conflict is
never auto-resolved, always surfaced to the employee explicitly. This also
required standing up the module's first genuinely new backend service —
Phases 1-2 needed zero backend code beyond one OAuth client seed entry.

## Decision

See docs/adr/0151 (schema/role) and docs/adr/0152 (JWT guards, idempotency,
sequential processing) for the full backend reasoning; summarized:

- `mobile-ess-service` (new, port 8800): `POST /v1/mobile/sync`, gated by
  real JWT verification (`AccessTokenGuard`/`TenantTokenMatchGuard`,
  copied from ai-layer-service/integration-hub-service, ADR-0130/0145) —
  not the `X-Tenant-Id`-only placeholder every other module's Phase 1
  started with, since this is a brand-new write endpoint producing real
  attendance data.
- `OfflineActionQueue.id` is client-generated and is the real per-action
  idempotency mechanism — a terminal row (`synced`/`conflict`)
  short-circuits to its cached result on retry; `isUniqueViolation` handles
  genuinely concurrent double-inserts the same way
  `attendance-ingestion.service.ts` already does for its own dedup.
- Each sync batch is processed **strictly sequentially, in array order**
  — a batch with a `clock_in` then `clock_out` for the same employee would
  otherwise race the clock-out's open-record read against the clock-in's
  still-open transaction.
- `clock_event` forwards to attendance-leave-service's real
  `POST /v1/attendance/tenants/:tenantId/clock-events` via
  `AttendanceClockEventClient` (HMAC-signed, modeled on
  `IntradayActivityEventClient`) — `occurredAt` carries `createdAtDevice`
  through unchanged; confirmed by reading `attendance-ingestion.service.ts`
  that the server applies zero derivation to it.
- Mobile-side: `expo-secure-store`, chunked (one key per queued action,
  ~2048-byte limit confirmed, paginated index at ~40 ids/page) — not
  SQLCipher-encrypted SQLite, which requires abandoning Expo Go/managed
  workflow (`npx expo prebuild`) and is unverifiable in this environment.
  All mutations serialized through one in-memory mutex per collection
  (`ChunkedSecureStore`), shared by the offline queue and the
  unresolved-conflicts store.

## Blast radius

Fully additive: a new backend service (own schema/role, no grant on any
other module's schema), a new `mobile-app` feature directory, one new
`apiPost` function alongside the existing `apiGet`/`graphqlRequest`. No
existing endpoint's behavior changed. `mobile-ess-service` calls
attendance-leave-service's existing, unmodified webhook endpoint.

## Rollback plan

Drop `mobile-ess-service` and its `mobile_ess` schema (migration's own
`down()`); revert `mobile-app/src/offlineQueue/`, the Schedule screen
additions, and `apiPost`. Nothing outside these depends on any of it.

## Explicit assumptions (spec was ambiguous or silent here)

1. **No GraphQL surface for this module in this phase.** The source spec
   lists `syncOfflineActions` as a GraphQL mutation, but Phase 3's own
   description names REST as the mechanism and `registerDevice` is
   explicitly Phase 5 — treated `syncOfflineActions` as the REST endpoint's
   conceptual name, not a second, redundant GraphQL entry point for the
   same operation.
2. **`receivedAt` added to `OfflineActionQueue`** beyond the spec's literal
   field list — the true server-first-saw-this-row timestamp, distinct
   from `createdAtDevice` and `syncedAt`, same "gained a timestamp even
   where the field list omitted it" posture Module 02 Phase 1 used.
3. **The platform's generic Redis-backed `IdempotencyInterceptor` is not
   reused.** Per-action-id upsert plus the mobile client's own mutex covers
   the real guarantee (a concurrent double-insert for a not-yet-existing
   id) without adding Redis as a new infrastructure dependency for a
   service that otherwise needs none. Documented as a deliberate trade in
   ADR-0152, not an oversight.
4. **`employeeId` is per-action, client-supplied, unverified against the
   session** — continuing ADR-0150's gap #2 (no `userId -> Employee`
   lookup exists anywhere). `mobile-ess-service` cannot check that the
   JWT's owner actually is the named employee. Named, not solved.
5. **Module 06's real gap, found while reading `attendance-ingestion.
   service.ts`: clock-in has no double-clock-in check at all** — only
   clock-out checks for an open record. A double clock-in produces two
   silently-open `AttendanceRecord` rows, no conflict, 202 success. Out of
   this phase's non-goals to fix (pre-existing Module 06 behavior, not a
   defect Module 11 introduced). Mitigated client-side only: the Schedule
   screen's Clock In/Clock Out buttons track "last queued event type"
   locally (`clockEvent.ts`) and show a same-type-twice warning before
   queuing — a UX nicety, explicitly not a correctness guarantee, and
   documented as such directly in the component's own code comment so a
   future reader doesn't mistake it for one.
6. **No "currently clocked in" status is displayed anywhere.** There is no
   read endpoint for it in the platform, and building one would be new
   business logic — against this module's explicit non-goals. The employee
   is trusted to press the correct button, the same way a physical badge
   reader doesn't prevent a double clock-in either (Module 06's own gap,
   item 5 above — this UI decision is a direct consequence of that gap,
   not an independent choice).
7. **Real conflicts this phase can actually produce**: `NoOpenAttendance
   RecordError` (clock-out, no open record) and `AttendanceRecordConflict
   Error` (concurrent-close race) — both surfaced via the conflict banner.
   Double-clock-in is explicitly NOT one of them (item 5).
8. **A conflict's only supported resolution is dismiss** — no
   retry-with-a-new-action-id flow. Sufficient for `clock_event`'s real
   conflict cases; flagged as an open question for whichever later phase
   needs a richer resolution UI (e.g. `marketplace_claim` conflicts,
   Phase 4, likely need more than dismiss).
9. **`EXPO_PUBLIC_API_BASE_URL` stays scheduling-service-specific** despite
   its generic-sounding name (confirmed by reading `useCurrentIdentity()`)
   — a new `EXPO_PUBLIC_MOBILE_ESS_API_BASE_URL` was added rather than
   reusing it, to avoid a silent cross-service mix-up.

## Out of scope for this phase (do not build yet)

- Fixing Module 06's double-clock-in gap (pre-existing, not Module 11's to
  fix) — mitigated client-side only, named explicitly above.
- `DeviceRegistration`/`registerDevice`/GraphQL surface (Phase 5).
- `leave_request`/`marketplace_claim` action types (Phase 4) — schema/enum
  already accepts them; `mobile-sync.service.ts` explicitly rejects them
  with "not yet supported" rather than mishandling them silently.
- Geofencing (Phase 6).
- A richer conflict-resolution UI beyond dismiss.
- Reusing the platform's generic Redis-backed `IdempotencyInterceptor`.

## Verification

- `cd mobile-ess-service && npm run lint && npm run typecheck && npm test`
  — 9 unit tests: idempotency (terminal-row short-circuit, unique-violation
  race), 202/409/401/503 status mapping, `createdAtDevice` threading
  through unchanged to `occurredAt`, strictly-sequential batch processing,
  not-yet-supported action types rejected cleanly.
- `cd mobile-app && npm run lint && npm run typecheck && npm test` — 34
  tests total; new: `ChunkedSecureStore` (pagination across pages,
  dangling-index-entry reconciliation, concurrent add+list serialization),
  `syncPendingActions` (synced/conflict/failed status handling, whole-batch
  network failure leaves actions queued without throwing, actions sent in
  `createdAtDevice` order).
- `npx expo export --platform web` (mobile-app) — end-to-end bundle smoke
  test, confirming the new Clock In/Out controls, conflict banner, and
  sync trigger wire together with the rest of the app.
- Manual local run against real Postgres (both services) + a real shared
  HMAC secret pair (`ATTENDANCE_WEBHOOK_SECRETS` /
  `ATTENDANCE_LEAVE_INGESTION_HMAC_SECRETS`): queue a clock-in offline,
  reconnect, confirm `AttendanceRecord.clockInAt` matches the
  device-captured timestamp exactly, not sync time. Not performed in this
  environment (no persistent Postgres/multi-service runtime here) — stated
  explicitly rather than claimed.
