# Module 06 Phase 6 Production Readiness Checklist

Same honesty bar as Phases 1–5. This phase introduces this service's first
gRPC *client* (previously only a gRPC server, Phase 5) - verified against a
real, running core service, not a mocked stub on either side of the wire.

## Delivered in this phase (application code)

- [x] `submitBackdatedLeave` (`POST /v1/leave/backdated-requests`) - a
      separate mutation/route from `requestLeave`, rejects a non-past
      `dateRangeStart` (`NotActuallyBackdatedError`), requires a
      non-empty `backdatedReason`, always takes the pending/reservation
      branch regardless of `LeaveType.requiresApproval` (ADR-0079).
- [x] `backdated_leave_entry` added to Module 01's RBAC `RESOURCES`
      catalog (root `src/database/seeds/run-seed.ts`) - confirmed against
      a real seed run that `backdated_leave_entry:{read,write,approve,delete}`
      permissions are actually created in `core.permissions`.
- [x] Elevated-permission gate on approving (not rejecting) a backdated
      `decideLeaveRequest` call - `InsufficientPermissionError` (403) when
      `backdated_leave_entry:approve` is absent from
      `dto.actorPermissions`, checked before the `LeaveBalance` row is
      locked. `backdatedApprovedBy` set on approval.
- [x] `AuditGrpcClientService`/`AuditGrpcClientModule` - this service's
      first gRPC client, calling core's real `AuditService.RecordEvent`.
      Best-effort/after-commit, for every decided backdated request
      (approve or reject), with `payrollResyncRequired` recorded on the
      audit event (`true` only on approval) - §5.1's flag requirement,
      honestly scoped given no Module 12 exists to actually call.
- [x] Three new metrics: `leave_backdated_submissions_total{result}`,
      `leave_backdated_permission_denials_total`,
      `leave_backdated_audit_events_total{result}`.
- [x] `BackdatedLeaveNotSupportedError`'s message text corrected - it
      previously said `submitBackdatedLeave` was "not yet available
      (Phase 6)," which this phase's own shipping makes stale; now points
      at the real endpoint.
- [x] Unit tests: 10 new/extended tests in `leave-request.service.spec.ts`
      (`submitBackdatedLeave`'s validation, force-pending behavior, and
      conflict-check reuse), 5 new tests in
      `decide-leave-request.service.spec.ts` (permission denial, approval
      with permission, rejection without permission, audit best-effort
      failure, no audit call for ordinary decisions), 4 new tests in
      `audit-grpc-client.service.spec.ts`. Node-side total: 108 tests
      across 16 suites, all passing. `typecheck`/`lint`/`build` all clean.

## Verified against real infrastructure end to end

- [x] Real local Postgres with root's own migrations *and* this service's
      migrations applied against the same database (ADR-0073's shared-DB
      pattern), plus a real run of root's seed script -
      `backdated_leave_entry:approve` confirmed present in
      `core.permissions` by direct query.
- [x] Real local Redis, real local NATS (with
      `AGNO_ATTENDANCE_LEAVE_EVENTS`/`_DLQ` streams provisioned).
- [x] A real, built core service (`node dist/src/main.js`) running its
      actual `AuditGrpcController`/`AuditEventBatcherService` - not a
      mock. A lightweight HTTP stub stood in for scheduling-service's one
      conflict-check endpoint (`GET .../shift-assignments` -> `[]`) -
      this phase's own logic is orthogonal to the conflict-check pipeline
      itself, which Phase 3 already verified against real behavior;
      standing up the full Python scheduling-service was correctly judged
      disproportionate to re-verifying unrelated functionality.
- [x] A real, built `attendance-leave-service`
      (`node dist/src/main.js`) pointed at both.
- [x] Full scenario run against real HTTP: submitted a backdated leave
      request (got back `status: pending, isBackdated: true`); attempted
      to approve it without `actorPermissions` (got a real `403
      INSUFFICIENT_PERMISSION`); approved it with
      `actorPermissions: ["backdated_leave_entry:approve"]` (got back
      `status: approved, backdatedApprovedBy: <actor>`); confirmed
      `LeaveBalance.used_days` incremented and `pending_days` released
      correctly; **queried `core.audit_log` directly after the batcher's
      2-second flush and found the real, durably-persisted row** with
      `action: approve_backdated_leave_request`,
      `after_state.payrollResyncRequired: true`; confirmed
      `submitBackdatedLeave` rejects a future date
      (`NOT_ACTUALLY_BACKDATED`) and an empty `backdatedReason`
      (validation error); confirmed deciding an already-decided backdated
      request a second time correctly returns `409
      LEAVE_REQUEST_ALREADY_DECIDED`; confirmed the ordinary
      `requestLeave` path is unaffected (still rejects a backdated date,
      now with the corrected message) - a genuine regression check, not
      an assumption.
- [x] Confirmed the new Prometheus counters increment correctly against
      real traffic (`leave_backdated_submissions_total{result="accepted"}`,
      `leave_backdated_permission_denials_total`,
      `leave_backdated_audit_events_total{result="published"}`).

## A genuine bug this verification caught (not hypothetical)

- **Circular import between `AuditGrpcClientModule` and
  `AuditGrpcClientService`.** The module file imported the service, and
  the service imported the `AUDIT_GRPC_PACKAGE` DI token back from the
  module file. This compiled cleanly and passed every unit test (which
  constructs `AuditGrpcClientService` directly, never loading either
  module file), but failed at real application boot with "a circular
  dependency has been detected inside AuditGrpcClientModule" - Nest's DI
  container only assembles its dependency graph at real bootstrap.
  Fixed by extracting the token to its own file
  (`audit-grpc-client.constants.ts`). This is exactly the class of bug
  this module's own "verify against real infrastructure, not just mocks"
  discipline exists to catch, and it did.

## Explicitly NOT done here (needs a later phase, or is out of scope)

- [ ] **Real Module 12 (payroll) integration.** `payrollResyncRequired` is
      recorded as audit-event data; nothing consumes it, because no
      payroll service exists anywhere in this platform.
- [ ] **Real JWT/session verification for `actorPermissions`.** Client-
      supplied and trusted, same as `decidedBy`/`employeeId` have been
      since Phase 3/4 - not a new gap, the existing one applied
      consistently. See the design doc's explicit assumption 1.
- [ ] **Multi-level/co-signer approval for backdated entries.** One actor,
      one decision - see explicit assumption 2.
- [ ] **GraphQL.**
- [ ] Phase 7 (carryover/expiry rule engine), Phase 8 (absence pattern
      detection) - unaffected by and unbuilt in this phase.
- [ ] **A separate gRPC process, TLS/mTLS, Terraform provisioning, Vault
      credential issuance, rate limiting, penetration testing / SOC2 /
      ISO27001, SAST / dependency scanning / SBOM.** Same explicit
      non-goals already stated platform-wide for every phase.
