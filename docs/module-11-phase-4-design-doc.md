# Module 11 Phase 4 Design Doc — Offline Sync for Leave/Marketplace + Conflict Surfacing

**Status:** Approved for implementation
**Owner:** Mobile / Employee Self-Service pod (Module 11)
**Scope:** `leave_request`/`marketplace_claim` working end to end through
`mobile-ess-service`, routed through each owning module's real validation
(§2.2 rule 3), plus the mobile UI (Leave/Marketplace tabs) to actually
queue them and a generalized conflict banner. No schema change —
`OfflineActionQueue`'s 3-value enum already existed from Phase 3.

## Problem

Phase 3 proved the offline-sync pattern end to end for one action type.
Phase 4 needed to answer: does that pattern generalize, or was
`clock_event`'s HMAC-webhook transport an accident of which module it
happened to target first? Reading the real target endpoints (not assumed)
showed neither `leave_request` nor `marketplace_claim` uses HMAC at all —
a second, real transport dialect (plain REST header-trust) and a third
(GraphQL header-trust) were both needed, confirming §2.2 rule 3's "reuse
the real validation pipeline" taken seriously means accepting whatever
transport each owning module actually built, not retrofitting a uniform
one Module 11 would have to invent.

## Decision

See docs/adr/0153 for full reasoning; summarized:

- `LeaveRequestClient` (plain REST, `X-Tenant-Id` only, reuses Phase 3's
  `ATTENDANCE_LEAVE_SERVICE_URL`) and `MarketplaceClaimClient` (GraphQL,
  `X-Tenant-Id`+`X-Actor-Id`, new `SHIFT_MARKETPLACE_SERVICE_URL`) added
  to `mobile-ess-service`, wired into `mobile-sync.service.ts`'s existing
  dispatch switch.
- `MobileSyncActionResult` gained an `actionType` field so `syncEngine.ts`
  can route a result to the correct conflict-store entry without relying
  on batch-array-position matching.
- A general, stated rule replaces per-status-code guesswork for
  conflict-vs-failed: `failed` = an unmodified retry could plausibly
  succeed with zero employee action; `conflict` = this exact payload will
  never succeed, full stop. Applied consistently across both new types.
- `MarketplaceClaimClient` never trusts `response.ok`/HTTP status for
  control flow — a resolver-thrown GraphQL error is still HTTP 200:
  `errors[]` is checked first, then a second independent signal
  (`data.claimOpenShift.claim.status === 'rejected'`) even when there are
  no errors at all.
- Manual `leaveTypeId`/`marketplacePostId` text entry on the new
  Leave/Marketplace tabs — confirmed no listing/read endpoint exists for
  either in Module 06/07, and building one would be new backend read
  capability in someone else's module.
- The Leave form enforces `dateRangeEnd >= dateRangeStart` client-side —
  a sync-queue-hygiene guardrail, not a forms nicety: without it,
  `InvalidLeaveRequestError` becomes a reachable, deterministic,
  always-reproducing conflict from the form's own input.
- `ConflictBanner` generalized: renders an action-type label
  ("Clock event"/"Leave request"/"Shift claim") alongside the backend's
  own already-tailored message.

## Blast radius

Additive within `mobile-ess-service`'s `mobile-sync/` directory and
`mobile-app`'s `offlineQueue`/`features` directories. No schema migration.
No existing endpoint in any service changed behavior — `mobile-ess-service`
only adds two new outbound callers.

## Rollback plan

Revert the two new providers/error-class pairs and their wiring in
`mobile-sync.service.ts` (the `CLOCK_EVENT` branch is untouched); revert
the mobile app's `leaveRequest.ts`/`marketplaceClaim.ts`, the two new tabs,
and `ConflictBanner`'s generalization. `storage.ts`/`conflicts.ts`'s
discriminated-union widening is backward compatible with Phase 3's
`clock_event`-only data already in a device's local queue.

## Explicit assumptions (spec was ambiguous or silent here)

1. **A real, disclosed idempotency asymmetry** — `clock_event` forwarding
   is idempotent twice over (this service's own row + attendance-leave-
   service's `sourceEventId` dedup); neither `leave_request` nor
   `marketplace_claim`'s target endpoint has an idempotency key at all. A
   crash between a successful upstream call and this row's `SYNCED` write
   creates a narrow but real double-submit window. Not fixed this phase
   (docs/adr/0153) — would require a new capability in Module 06/07's own
   endpoints.
2. **`POST /v1/leave/backdated-requests` exists and is deliberately not
   used** for the stale-offline-request case (`BackdatedLeaveNotSupportedError`)
   — its `backdatedReason` is mandatory free text the employee never
   supplied when queuing offline; auto-fabricating one would be an
   uncomfortably close cousin of auto-resolving a conflict. Named
   explicitly so a future reader doesn't mistake this for an unnoticed gap.
3. **`POST_NOT_OPEN` (marketplace) covers 4 states**, not just "someone
   else claimed it" — `MarketplacePost.status` is
   `open`/`claimed`/`expired`/`cancelled`. The conflict banner's copy for
   this case is generic ("this shift's status changed while you were
   offline"), not narrowly claim-race-specific.
4. **Found and fixed while writing the Leave form's own test: `expo-crypto`
   wasn't mocked in Jest at all.** `Crypto.randomUUID()` resolved to
   `undefined` under jest-expo's generic native-module auto-mock (not a
   throw) — an `undefined` action id serializes inconsistently through
   `JSON.stringify` (stays the literal string `"undefined"` in a
   template-literal key, but becomes `null` inside an array), which
   silently corrupted `ChunkedSecureStore`'s own index-vs-payload
   reconciliation and made a freshly-queued action vanish on the very next
   `list()` call. This was a real, previously-latent bug in Phase 3's own
   `clockEvent.ts` too — never caught because no Phase 3 test exercised
   the full UI-to-storage path with a real `Crypto.randomUUID()` call,
   only `syncEngine`/`storage` tests with manually-supplied ids. Fixed
   with a narrow test-only override (`src/testing/mocks/crypto.ts`,
   `randomUUID` only — `getRandomBytesAsync`/`digestStringAsync` were
   deliberately left untouched, confirmed already working correctly via
   Phase 2's passing PKCE-dependent tests).
5. **No native date-picker dependency added** for the Leave form's two
   date fields — plain validated `YYYY-MM-DD` text entry. A scope cut, not
   an oversight.
6. **`ConflictBanner` is rendered on all three relevant tabs** (Schedule,
   Leave, Marketplace), not centralized in one place — each instance
   independently fetches/dismisses against the same underlying store. A
   minor, accepted rough edge (a dismiss on one tab doesn't immediately
   refresh another tab's already-mounted banner instance) rather than
   introducing a global state store for this phase.

## Out of scope for this phase

- Building `GET /v1/leave/types`/`GET /v1/leave/balances`/a marketplace
  list query in Module 06/07.
- Wiring into `POST /v1/leave/backdated-requests`.
- Fixing the leave/marketplace idempotency asymmetry.
- A native date-picker component.
- `DeviceRegistration`/`registerDevice`/GraphQL surface (Phase 5),
  geofencing (Phase 6).
- A richer conflict-resolution UI beyond dismiss.

## Verification

- `cd mobile-ess-service && npm run lint && npm run typecheck && npm test`
  — 36 tests: new `leave-request.spec.ts`/`marketplace-claim.spec.ts`
  (service-level dispatch) plus `leave-request-client.spec.ts`/
  `marketplace-claim-client.spec.ts` (transport-level, including the
  GraphQL success-but-rejected case and the never-trust-`response.ok`
  discipline).
- `cd mobile-app && npm run lint && npm run typecheck && npm test` — 39
  tests: new offline-queue coverage for both action types (mixed-batch
  sync, per-type conflict routing) and `LeaveRequestScreen`'s date-order
  guardrail (both the rejection and the successful-queue path — the
  latter is what surfaced the `expo-crypto` mock bug above).
- `npx expo export --platform web` (mobile-app) — end-to-end bundle smoke
  test confirming the new Leave/Marketplace tabs wire together with the
  rest of the app.
- Manual local run against real Postgres + running attendance-leave-service
  and shift-marketplace-service instances: not performed in this
  environment (no persistent multi-service runtime here) — stated plainly
  rather than claimed.
