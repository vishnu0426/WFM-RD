# ADR-0154: Push notifications — REST `registerDevice` (not GraphQL), a single real NATS-consumer slice standing in for Module 01's non-existent dispatcher, and a gRPC preference check

## Context

Phase 5's spec instruction is short: "`registerDevice`, wiring into
Module 01's existing notification center." Reading Module 01's actual
code (`src/modules/notification/`) before building anything showed the
premise doesn't hold: `NotificationPreference` (tenant/user/channel/
eventType/enabled/quietHours) is a preferences table with a read-only
repository (`NotificationPreferencesRepository.findForUser`) and nothing
else. There is no dispatch service, no NATS consumer, no REST/GraphQL
surface — nothing in this repo sends an email, an SMS, or a push,
anywhere. The only existing consumer, `skill-decay-job.service.ts`, just
logs who *would* be notified, with its own doc comment stating plainly
that no delivery mechanism exists yet.

So "wire into the existing notification center" isn't achievable as
written — there's nothing to wire into. This ADR documents what was built
instead: a narrow, real, end-to-end slice that proves the actual
mechanism (registration → preference check → send → dead-token cleanup)
works, scoped tightly enough that it doesn't become "build Module 01's
entire notification dispatcher" as an uncredited side effect of a mobile
client module.

`DeviceRegistration` didn't exist anywhere before this phase — a clean
slate, one new migration in `mobile-ess-service`'s own `mobile_ess`
schema.

## Decision

### 1. `registerDevice` is REST, not GraphQL

Same call ADR-0151 already made for `syncOfflineActions`: `mobile-ess-
service` has no GraphQL infrastructure at all (no Apollo module, no
resolver pattern, no `schema.gql`) and `DeviceRegistration` is this
service's own schema/table. `POST /v1/mobile/devices`, guarded by the
same `AccessTokenGuard`+`TenantTokenMatchGuard` pair every other endpoint
in this service uses. Upsert semantics, keyed on the entity's own
`(tenant_id, employee_id, device_type)` UNIQUE constraint — every call
(fresh registration or a repeat call on every authenticated-session-start)
is one idempotent write; there is no separate heartbeat endpoint.

The spec's `DeviceRegistration` DDL has no device-identifier column, only
`device_type` (`ios`/`android`) — so one row per employee per platform is
the only key it actually supports, even though the mobile app already
mints a per-install id (`mobile-app/src/lib/deviceId.ts`) that could have
supported multiple same-platform devices. Taken literally: an employee
registering a second iPhone silently overwrites the first phone's token
(last-active-wins), and the first phone simply stops receiving pushes
with no error surfaced anywhere. Disclosed here as a real, deliberate
scope cut, not an oversight — supporting it would mean deviating from the
spec's own stated schema, which this module has otherwise held to closely
across every prior phase.

### 2. Module 01's notification center doesn't exist as a dispatcher — build one real slice, not a generic one

Rather than build a general-purpose multi-event, multi-channel dispatcher
(new scope no one asked for, and squarely the kind of "business logic
beyond device/offline handling" §8's non-goals reject), this phase wires
exactly one already-published, already-explicitly-earmarked-for-
notifications domain event end to end:
`agno.leave.request.approved.v1` (`attendance-leave-service`). Its own
payload/doc comment already says: "Consumed by ... Module 01's
`AuditLog`/notification pipeline (§4's architecture) - neither consumer
is built in this repo yet." This is as close to "the spec's own intended
integration point" as anything in the platform gets.

This required `mobile-ess-service`'s first NATS wiring (Phases 1-4 were
pure REST) — a direct copy of `intraday-service`'s own `NatsClientService`/
`bindDurableConsumer`/`DurableJetStreamConsumer` pattern (ADR-0039's
established precedent: each service owns its NATS client rather than
sharing one). `LeaveRequestApprovedConsumerService` subscribes to
attendance-leave-service's already-provisioned
`AGNO_ATTENDANCE_LEAVE_EVENTS` stream — a new *consumer*, not a new
stream — the same cross-service-subscription relationship
`SchedulePublishedConsumerService` already has to scheduling-service's
stream.

Marketplace's `CLAIM_APPROVED`/`SWAP_EXECUTED` events are explicitly out
of scope this phase. Their own doc comment names scheduling-service as
their current *only* subscriber (ADR-0089) — adding push as a second
subscriber is a materially bigger conceptual claim than leave's
already-notification-earmarked event, and doing both this phase would
double the surface for no proportionate validation of the underlying
pattern.

### 3. The gRPC preference check extends an existing direction, not a new one

The real "wiring into Module 01's notification center" this phase
delivers: before sending, `mobile-ess-service` checks
`NotificationPreference`'s `PUSH` channel via a new inbound RPC on
platform-core, `NotificationPreferenceService.IsPushEnabled`
(`src/grpc/proto/notification.proto`,
`src/grpc/controllers/notification-preference-grpc.controller.ts`). This
is the same direction every existing gRPC caller already uses —
`PolicyGrpcController`/`EmployeeGrpcController`/`AuditGrpcController` are
all called *into* by other services; `shift-marketplace-service`'s
`EmployeeGrpcClientService` is the template this phase's own client
(`mobile-ess-service/src/grpc/notification-preference-grpc-client.*`)
copies. Not a new architectural direction — an extension of one already
proven three times over.

`channel` is hardcoded to `PUSH` on the RPC itself, not passed as a
request field — the contract stays honest about what's actually
implemented (one channel) rather than presenting a generic multi-channel
surface nothing behind it serves yet.

**The RPC also resolves `employeeId -> userId`, folded into this same
call rather than exposed as its own RPC.** `NotificationPreference` is
keyed by `core.users.id`; `DeviceRegistration` (and the NATS payload) are
keyed by `employeeId`. `Employee.userId` (nullable — an employee without
a linked login has none) is already a real, already-injectable column via
`EmployeesRepository`, already wired into `GrpcModule` for
`EmployeeGrpcController`. This is a same-process repository call, not new
cross-module capability, and nothing else in the platform needs a
standalone `employeeId -> userId` RPC yet — building one speculatively
would be scope this phase doesn't need.

### 4. Default when no preference row exists: enabled (opt-out)

`NotificationPreferencesRepository` is read-only platform-wide — nothing
anywhere writes a row (no preference-center UI exists). An opt-in default
would mean push notifications are silently, permanently off for every
employee until some future, unbuilt UI creates an explicit row — i.e.
this phase would ship a feature that structurally never fires for anyone.
Opt-out matches `NotificationPreference.enabled`'s own column default of
`true`; this decision only extends that same default to the "no row at
all" case, not a new posture.

### 5. Dead-token cleanup: soft `active = false`, no DELETE grant

`ExpoPushClient` never trusts bare `response.ok` to mean "delivered" —
Expo's push API returns HTTP 200 with a per-message `data[]` array where
each ticket independently carries `status: 'ok' | 'error'`. Only
`errorType === 'DeviceNotRegistered'` (Expo's own documented signal for a
genuinely dead token) triggers `DevicesService.markInactive` — a plain
`UPDATE ... SET active = false`. `mobile_ess.device_registration`'s
migration grants `agno_mobile_ess_app` only `SELECT, INSERT, UPDATE`, no
`DELETE` — matching `offline_action_queue`'s own established
never-hard-delete posture. `mobile_push_dead_token_total` and
`mobile_push_delivery_attempts_total{outcome}` (new `MetricsService`
counters) are the actual §0.5 on-call deliverable — an external
Prometheus/Alertmanager rule thresholds on these; building that rule
itself is out of scope, the same metrics-only/alerting-is-ops-config
split every other service in this platform already follows.

A per-device Expo send failure (network blip, not a `DeviceNotRegistered`
ticket) is caught inside `PushDispatchService` and never propagates to
the NATS consumer — only the gRPC preference-check failure does. The
preference check is a single per-event call made before anything is
sent, so redelivering it on failure is risk-free; a per-device Expo
failure happens *after* some devices on the same employee's account may
already have been sent to successfully, and letting it nak the whole
event would duplicate-send to those already-succeeded devices on
redelivery.

### 6. External blocker, named not worked around: no EAS project provisioned

`expo-notifications`' `getExpoPushTokenAsync()` requires a real EAS
`projectId`; this repo has none configured (`app.config.ts` has no
`extra.eas.projectId`, no `.env.example` entry existed before this
phase). Provisioning one (`eas init` against a real Expo account) is an
external, account-level action this repo's code cannot perform on its
own behalf. `EXPO_PUBLIC_EAS_PROJECT_ID` was added to `.env.example` with
this stated plainly; `pushToken.ts` throws a clear, named error when it's
unset rather than calling the SDK with an undefined project id and
surfacing an opaque failure. Same discipline as ADR-0150's `employeeId`
dev-stub disclosure — named explicitly so a future reader doesn't mistake
this for an unnoticed gap.

## Consequences

- `mobile-ess-service` gained its first NATS dependency and its first
  outbound gRPC client — real new infrastructure, not just new business
  logic in an existing shape. A future phase adding a second event type
  or a second gRPC-consuming preference reuses this scaffolding directly.
- Push notifications only actually fire for one event
  (`leave.request.approved`) until a future phase (or Module 01's own
  backlog) adds more. This is a real, disclosed functional gap, not a
  hidden one — an employee's shift being claimed by someone else, a
  schedule being published, etc. do not yet produce a push.
- Quiet-hours (`NotificationPreference.quietHoursStart`/`quietHoursEnd`)
  are stored but not enforced — `IsPushEnabled` reads only `enabled`.
  Enforcing them needs a timezone source that doesn't exist anywhere in
  the platform yet (tenant's? employee's?) and a defer-vs-drop delivery
  decision — a second real feature, not a checkbox this phase could add
  cheaply.
- No deep-link routing on notification tap — `notificationListeners.ts`'s
  response listener is a deliberate no-op. Tapping a push shows the OS
  notification only.
- Push notifications cannot function in this environment (or any
  environment) until someone runs `eas init` and sets
  `EXPO_PUBLIC_EAS_PROJECT_ID` — a one-time, external, human action.
- An employee's second same-platform device silently displaces the
  first's push token on registration (§1) — acceptable given the spec's
  own DDL, but worth remembering if a future phase adds true multi-device
  support (it would need a new column and a migration, not just an app
  change).
