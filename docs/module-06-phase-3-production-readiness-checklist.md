# Module 06 Phase 3 Production Readiness Checklist

Same honesty bar as Phase 1/2. This phase adds the module's first
correctness-critical concurrency guarantee (§2.2 rule 1) - the delivered
list below is verified against a real Postgres running genuinely
concurrent requests, not just unit tests against mocked repositories,
because that is the only way §6's own ask can actually be proven.

## Delivered in this phase (application code)

- [x] `POST /v1/leave/requests` (`LeaveRequestController`), tenant from
      `TenantContextMiddleware`'s existing header-trust binding (Phase 1).
- [x] Input validation: `dateRangeEnd >= dateRangeStart`, and
      `dateRangeStart` not backdated (rejected outright -
      `submitBackdatedLeave` doesn't exist until Phase 6).
- [x] Synchronous, fail-closed conflict check (§2.2 rule 2): Module04
      schedule-conflict detection is real (shared `ScheduleServiceClient`,
      moved to `src/common/scheduling/` this phase); Module02 org-coverage
      is honestly `null` (no fabricated result) - see ADR-0076 for why no
      capability exists to call at all.
- [x] Concurrency-safe `pending_days` reservation (§2.2 rule 1, ADR-0074):
      `SELECT ... FOR UPDATE` on the exact `LeaveBalance` composite-PK row,
      `availableDays` computed from the locked read, parameterized
      `increment()` (never string-built SQL), all in one transaction with
      the `LeaveRequest` insert.
- [x] A same-schema foreign-key gap from Phase 1
      (`leave_balance`/`leave_request.leave_type_id` -> `leave_type.id`)
      found and fixed via a new additive migration, not a rewrite of the
      already-applied Phase 1 migration.
- [x] Standard REST error envelope extended: `INVALID_LEAVE_REQUEST` (400),
      `BACKDATED_LEAVE_NOT_SUPPORTED` (400), `LEAVE_BALANCE_NOT_FOUND` (404),
      `INSUFFICIENT_LEAVE_BALANCE` (409), registered in `DomainErrorFilter`.
- [x] Metrics: `leave_request_submissions_total{result}`,
      `leave_balance_lock_duration_seconds`.
- [x] Unit tests: `LeaveConflictCheckService` (overlap detection, fail-
      closed on scheduling-service failure) against a mocked
      `ScheduleServiceClient`; `LeaveRequestService` (validation ordering,
      backdated rejection, insufficient-balance/no-balance-row paths, that
      the conflict check always runs before any transaction opens) against
      a mocked `DataSource`/`EntityManager`; the new migration's shape
      (both FKs, both indexes). No live Postgres or scheduling-service
      required to run `npm test`.
- [x] **New**: `test/integration/leave-request-concurrency.spec.ts`
      (`npm run test:integration`, requires a real Postgres) - §6's
      dedicated concurrency test. Seeds one `LeaveBalance` row with room
      for exactly one of two concurrent requests, fires both genuinely
      concurrently (`Promise.all`) against a real `LeaveRequestService`
      wired to a stub conflict-check (isolates the balance-lock behavior
      from a live scheduling-service dependency), and asserts exactly one
      `LeaveRequest` is created, the other rejects with
      `InsufficientLeaveBalanceError`, and the final `pending_days` value
      reflects only the winner - never both, never neither.
- [x] Verified against a real local Postgres end to end, not just the
      integration test above: both Phase 3 migrations apply cleanly on top
      of Phase 1/2's, `POST /v1/leave/requests` exercised over real HTTP
      against the built app (with a stub `scheduling-service`) for the
      accepted, insufficient-balance, backdated-rejection,
      invalid-date-range, unknown-`leaveTypeId`, and unknown-`employeeId`
      cases, each producing the documented status code and error envelope.
      **This is what caught a real finding, not a hypothetical one**: an
      earlier version of `LeaveRequestService` caught the new FK's
      violation and mapped it to a dedicated `LeaveTypeNotFoundError`; real
      requests showed that path is unreachable (the balance lookup, keyed
      by `leaveTypeId`, always hits `LeaveBalanceNotFoundError` first for
      any `leaveTypeId` without a matching balance row). Removed rather
      than left as untested-in-practice dead code with a misleadingly
      passing unit test - see the design doc's Decision section and
      Rollback plan for the full writeup.

## Explicitly NOT done here (needs a later phase)

- [ ] **`decideLeaveRequest`, the BullMQ approval-chain workflow, and the
      `pending_days` -> `used_days` transition on approval.** A submitted
      `LeaveRequest` sits at `status: pending` with no path to `approved`/
      `rejected` yet - Phase 4.
- [ ] **Module02 org-coverage evaluation.** `conflict_flags.orgCoverage`
      is permanently `null` until Module 02 exposes a real capability - not
      this module's gap to close. See ADR-0076.
- [ ] **`LeaveService.GetUnavailability`/`CheckScheduleConflict` for
      Module 04, and the `agno.leave.request.approved.v1` NATS publish.**
      No gRPC server or NATS client exists in this service yet - Phase 5.
      Module04's `scheduling-service` still runs on its Phase 2/6 interim,
      request-supplied `leaveRecords` posture (ADR-0059) - this phase does
      not close that gap, only builds toward it.
- [ ] **`submitBackdatedLeave` and the elevated backdated-leave permission.**
      A backdated submission via `requestLeave` is rejected outright; there
      is currently no way to submit backdated leave through this service
      at all. Phase 6.
- [ ] **`LeaveBalance` provisioning/accrual.** This phase only reads and
      increments existing rows - nothing in this service creates them.
      Verification above relied on directly-seeded rows, standing in for
      whatever real mechanism eventually provisions balances.
- [ ] **Cross-period leave requests, half-day leave.** Both explicitly
      out of scope (design doc's assumptions 2 and 4) - a request spanning
      more than one balance period, or a fractional day, is rejected/
      miscounted respectively, not specially handled.
- [ ] **GraphQL (`requestLeave` mutation, `myLeaveBalances`/`leaveRequests`
      queries).** REST only this phase, same posture Phase 2 took.
- [ ] **Load/concurrency testing beyond the two-requester §6 case.** The
      integration test proves the lock is correct for the specific race
      §6 describes; it is not a throughput or high-concurrency (dozens of
      simultaneous requesters against one row) benchmark.
- [ ] **Terraform for real Postgres provisioning, Vault for credential
      issuance, in-process/gateway rate limiting, penetration testing /
      SOC2 / ISO27001, SAST / dependency scanning / SBOM.** Same explicit
      non-goals already stated platform-wide for every phase.
