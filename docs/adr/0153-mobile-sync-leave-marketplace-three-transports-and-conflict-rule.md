# ADR-0153: Leave/marketplace offline sync uses two more transport dialects (plain REST header-trust, GraphQL header-trust), and a general conflict-vs-failed rule replaces per-status-code guesswork

## Context

Phase 3 established one pattern for reusing an owning module's real
validation pipeline (§2.2 rule 3): `AttendanceClockEventClient` HMAC-signs
a webhook-shaped request, because that's what
`POST /v1/attendance/tenants/:tenantId/clock-events` actually requires.
Phase 4 extends `mobile-sync.service.ts` to `leave_request` and
`marketplace_claim` — reading the real target endpoints (not assumed)
showed neither uses HMAC at all:

- `POST /v1/leave/requests` (attendance-leave-service) has **no guard**.
  Tenant comes from `TenantContextService.requireTenantId()` (`X-Tenant-Id`
  header, ADR-0014's placeholder — the same convention every other
  non-webhook endpoint in this platform uses). `employeeId` is a plain,
  unverified body field.
- `claimOpenShift(postId: ID!)` (shift-marketplace-service) is **GraphQL
  only**, also unguarded — `X-Tenant-Id` + `X-Actor-Id` headers
  (ADR-0014/ADR-0084). No `employeeId` argument exists on the mutation at
  all; the claimant is entirely the `X-Actor-Id` header value.

So Module 11 now speaks three genuinely different dialects to forward
actions — HMAC webhook, plain REST header-trust, GraphQL header-trust —
each matching exactly what its owning module actually built. This is
§2.2 rule 3 ("reuse the real validation pipeline, not a simplified
mobile-specific approximation") taken to its logical conclusion: three
different transports is the correct cost of that principle, not something
to paper over with a uniform client abstraction Module 11 would have to
invent.

## Decision

**`LeaveRequestClient`** (`src/mobile-sync/providers/leave-request-client.ts`):
plain REST POST, `X-Tenant-Id` only, relies on real HTTP status codes
(`response.ok` is a valid control-flow signal here, unlike the GraphQL
client below).

**`MarketplaceClaimClient`** (`.../marketplace-claim-client.ts`): GraphQL
POST, `X-Tenant-Id` + `X-Actor-Id: <employeeId>`. **Never branches on
`response.ok`/HTTP status for control flow** — a resolver-thrown domain
error still returns HTTP 200 with a GraphQL `errors[]` array (Apollo's
default). Always parses the body and checks `errors[]` first, `data`
second. Confirmed `GUARDRAIL_VALIDATION_UNAVAILABLE` (Module 04 gRPC down)
always surfaces via `errors[]`, never a success body — `claim-open-
shift.service.ts` re-throws after its best-effort DB write. But a
**separate, independent signal** exists: HTTP 200, no `errors[]`, yet
`data.claimOpenShift.claim.status === 'rejected'` (a stale post or a real
eligibility violation) — this is still a conflict, detected only by
inspecting the success payload, not by catching an exception. The client
folds both signals into the same `MarketplaceClaimConflictError`, so
`mobile-sync.service.ts` doesn't need its own awareness of the nuance.

**Conflict-vs-failed: one general rule, not per-status-code guesswork.**
`failed` means *an unmodified retry could plausibly succeed with zero
employee action* — and since a `failed` action is retried silently
forever with zero employee-facing surfacing (`syncEngine.ts` just leaves
it queued), that property has to actually hold, not just "feels like an
infra error." `conflict` means *this exact payload will never succeed,
unmodified, full stop* — whether because state drifted while the device
was offline (insufficient balance, already-claimed, post no longer open)
or because the payload itself is permanently wrong (missing balance row,
inverted date range, a request that went stale offline). Applied:

| Signal | Maps to |
|---|---|
| `InsufficientLeaveBalanceError` (409), `LeaveBalanceNotFoundError` (404), `BackdatedLeaveNotSupportedError` (400), `InvalidLeaveRequestError` (400) | `conflict` |
| `UpstreamUnavailableError` (503), network failure | `failed` |
| `POST_ALREADY_BEING_CLAIMED`, `POST_NOT_OPEN`, `MARKETPLACE_POST_NOT_FOUND`, success-body `claim.status === 'rejected'` | `conflict` |
| `CLAIM_ATTEMPT_RATE_LIMITED`, `MARKETPLACE_UNAVAILABLE`, `GUARDRAIL_VALIDATION_UNAVAILABLE`, network failure | `failed` |

`CLAIM_ATTEMPT_RATE_LIMITED` → `failed` is confirmed safe, not just
convenient: `ClaimAttemptRateLimiterService.assertNotRateLimited` never
itself increments the rate-limit window (only `recordFailedAttempt` does),
so blind-retrying a rate-limited claim on every sync pass doesn't make the
throttling worse.

`InvalidLeaveRequestError` (inverted `dateRangeStart`/`dateRangeEnd`) is
mapped to `conflict` as **defense in depth only** — the mobile Leave
form's own client-side validation (`app/(tabs)/leave.tsx`) enforces
`dateRangeEnd >= dateRangeStart` before allowing submission, making this
error effectively unreachable from the app's own UI. It must never map to
`failed`: unlike a scheduling-service outage, this payload shape cannot
change on its own no matter how many times it's retried.

**`POST_NOT_OPEN` covers four states, not one.** `MarketplacePost.status`
has a 4-value enum (`open`/`claimed`/`expired`/`cancelled`) — this error
means the post moved to *any* terminal state while offline, not
specifically "someone else claimed it first." The mobile conflict banner's
copy for this case says "this shift's status changed while you were
offline," not "someone else claimed it," since `cancelled` (a supervisor
pulling the post) is a materially different situation to word for the
employee.

**Idempotency asymmetry, named, not fixed.** `clock_event` forwarding is
idempotent twice over: `OfflineActionQueue.id`'s terminal-status
short-circuit, *and* attendance-leave-service's own `sourceEventId` dedup
on the target table. Neither `RequestLeaveDto` nor `claimOpenShift(postId)`
carries an idempotency key at all. A crash between a successful upstream
call and this row's `status = SYNCED` write creates a real (if narrow)
double-submit window on the next sync pass — a second leave request
debiting a balance twice, or a second claim attempt against an
already-claimed post (comparatively harmless there, since the post is
already non-`open`). Not fixed this phase: adding an idempotency key to
Module 06/07's own endpoints is new capability in someone else's module,
against Module 11's own explicit non-goal.

**`POST /v1/leave/backdated-requests` exists; Module 11 declines to use
it.** Module 06 Phase 6 already built a real resolution path for a leave
request that should have been submitted in the past
(`SubmitBackdatedLeaveDto`/`submitBackdatedLeave`) — exactly the mechanism
§2.2 rule 3 would point to for the offline-delay scenario
`BackdatedLeaveNotSupportedError` represents. Module 11 is *not* wiring
into it this phase: `backdatedReason` is mandatory free text the employee
never supplied when they queued the (then-valid) request offline, and
auto-fabricating one to resubmit would be an uncomfortably close cousin of
auto-resolving a conflict, even though it isn't literally one. Recorded
here so a future reader knows this is a deliberate scope cut with a real
pointer, not a gap nobody noticed.

**No listing/read endpoints for either type — manual ID entry, not new
backend capability.** Confirmed: no `GET /v1/leave/types`, no
`GET /v1/leave/balances`, and shift-marketplace-service has only a
single-item `marketplacePost(id)` query, no list query at all. The mobile
Leave/Marketplace forms use manual `leaveTypeId`/`marketplacePostId` text
entry, with a visible note explaining why — building the missing list
endpoints would be new backend read capability in Module 06/07, against
Module 11's own explicit non-goal.

## Consequences

- Three HTTP clients, three auth conventions, in the same service — a
  future engineer extending Module 11 to a fourth action type should
  expect a fourth dialect, not assume one of these three is "the"
  pattern to copy blindly.
- `MobileSyncActionResult` gained an `actionType` field (was
  `{actionId, status, conflictDetails?, detail?}`) so `syncEngine.ts` can
  route a result back to the correct `QueuedConflict` variant without
  relying on batch-array-position matching.
- The employee cannot see a friendly leave-type name or a real shift time
  before submitting either form — both are free-text ids, an honest,
  visible limitation, not a hidden one. Resolved only if/when Module 06/07
  ship their own read-side listing endpoints.
- A real, if narrow, double-submit window exists for leave requests and
  marketplace claims under a crash-at-exactly-the-wrong-moment scenario —
  disclosed, not fixed, same posture as ADR-0150's `employeeId` gap.
