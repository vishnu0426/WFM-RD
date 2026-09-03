# Module 06 Phase 5 Production Readiness Checklist

Same honesty bar as Phases 1–4. This phase spans two repositories
(`attendance-leave-service/` and `scheduling-service/`) and introduces
this service's first gRPC server and first NATS publish - the delivered
list is verified against real Postgres, real Redis, a real NATS broker,
and a real cross-language gRPC call (a genuine Python client hitting a
genuine running Node server), not mocks on either side of the wire.

## Delivered in this phase (application code)

- [x] `LeaveService.GetUnavailability` gRPC server (`LeaveGrpcController`),
      `WHERE status = 'approved'` structurally enforced (§2.2 rule 2,
      ADR-0057), tenant context bound per-handler (no HTTP middleware
      applies to gRPC).
- [x] `main.ts`/`nest-cli.json` gRPC transport wiring, verified against a
      real production build (`npm run build` + `node dist/src/main.js`) -
      not just `ts-node`/dev-mode, where a missing `nest-cli.json` assets
      config would not have surfaced.
- [x] `agno.leave.request.approved.v1` NATS publish
      (`AttendanceLeaveNatsClientService`, own copy per ADR-0039), best-
      effort/after-commit, `Nats-Msg-Id` dedup via JetStream's `msgID`
      option keyed on `leaveRequestId`. `AGNO_ATTENDANCE_LEAVE_EVENTS` +
      `AGNO_ATTENDANCE_LEAVE_DLQ` streams added to
      `scripts/provision-nats-streams.ts`.
- [x] §0.5's propagation-latency histogram
      (`attendance_leave_approval_propagation_duration_seconds`, declared
      since Phase 1) wired for the first time - observes real durations
      now, though only for the push path's own slice (see design doc's
      explicit assumption 4).
- [x] scheduling-service: `ScheduleJobRequest.leave_records` is now
      `Optional`, `_resolve_leave_records` pulls via `leave_client.py`
      when omitted (mirroring `_resolve_roster`/`_resolve_policy`
      exactly), `LeaveRecord`'s docstring updated to reflect the gap is
      closed, not still-pending.
- [x] Unit tests: `LeaveGrpcController` (approved-only filtering, empty-
      employee-ids handling, response mapping) against a mocked
      `DataSource`/`EntityManager`; `AttendanceLeaveNatsClientService`
      (publish/msgID/reconnect/fail-visible/drain) against a mocked
      `nats` module; `DecideLeaveRequestService`'s NATS publish (fires on
      approval only, never on rejection, best-effort on failure) - Node
      side, 78 tests total, all passing. `leave_client.py`'s response
      conversion (mocked stub) and `_resolve_leave_records`'s branching
      (explicit list/explicit empty list/omitted, all three cases) -
      Python side, 6 new tests, 88 total scheduling-service unit tests
      passing (no regressions from the schema change). `mypy`/`ruff`
      clean on both the new and touched files.
- [x] Verified against real infrastructure end to end: real local
      Postgres + real local Redis + real local `nats-server`, the actual
      built `attendance-leave-service` (gRPC server on `:7000`, HTTP on
      `:8300`), approved `decideLeaveRequest` calls confirmed to actually
      publish to the real NATS stream (subscribed and observed the
      message), and - the highest-value check for this phase - a real
      Python script using the real generated `leave_pb2_grpc.LeaveServiceStub`
      called the live gRPC server directly and got back correct
      `UnavailabilityRecord` data for a seeded approved `LeaveRequest`,
      proving the cross-language wire contract actually works, not just
      that each side's own unit tests pass in isolation.

## Explicitly NOT done here (needs a later phase)

- [ ] **`submitBackdatedLeave`, the elevated backdated-leave permission.**
      Phase 6.
- [ ] **Any real consumer of `agno.leave.request.approved.v1`.** Neither
      Module 01's AuditLog/notification pipeline nor a scheduling-service-
      side subscriber exists. The event is produced and schema-documented
      (ADR-0078); nothing reads it yet.
- [ ] **A true end-to-end propagation-latency measurement.** §0.5's SLO
      (p99 < 2s, leave-approval → Module 04 visibility) is only measured
      for this service's own push-path slice - scheduling-service's pull
      path has no timing instrumentation of its own, and with no NATS
      consumer, there is no "time until Module 04 actually saw it" signal
      to close the loop with. Flagged, not claimed closed.
- [ ] **`CheckScheduleConflict` as a gRPC method.** Deliberately not
      built - that direction is REST (Phase 2/3), per Phase 1's own
      explicit assumption. See design doc explicit assumption 1 for why
      §3.4's literal wording doesn't override that.
- [ ] **Reoptimize-path leave-record pulling.**
      `ReoptimizeScheduleRequest.leave_records` stays request-supplied-only.
- [ ] **`scheduling-service`'s own full integration-test suite
      (`tests/integration/`) was not re-run end to end** against this
      phase's changes - it requires a fully provisioned multi-service
      Postgres/gRPC environment beyond this phase's own scope to stand up
      from scratch. The 88 unit tests plus this phase's own real-server
      cross-language verification (above) are the actual evidence this
      phase's changes work; the pre-existing integration suite's own
      pass/fail status for *unrelated* scheduling-service functionality
      was not re-verified.
- [ ] **GraphQL.**
- [ ] **A separate gRPC/NATS process, TLS on either transport, mTLS
      between services, Terraform provisioning, Vault credential
      issuance, in-process/gateway rate limiting on the gRPC surface,
      penetration testing / SOC2 / ISO27001, SAST / dependency scanning /
      SBOM.** Same explicit non-goals already stated platform-wide for
      every phase (plaintext/insecure gRPC channels throughout this
      platform, matching every existing gRPC client/server pair).
