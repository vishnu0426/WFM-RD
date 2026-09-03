# Module 06 Phase 2 Production Readiness Checklist

Same honesty bar as Phase 1's own checklist. This phase adds one real
request path (badge/biometric clock-event ingestion) - the delivered list
is correspondingly larger than Phase 1's, but still bounded to exactly
§3.2/§2.2 rule 3's scope.

## Delivered in this phase (application code)

- [x] `POST /v1/attendance/tenants/:tenantId/clock-events`
      (`AttendanceIngestionController`), HMAC-guarded
      (`HmacSignatureGuard`, own copy of intraday-service's verifier),
      DTO-validated (`ClockEventDto`).
- [x] Postgres-unique-constraint idempotency (ADR-0075):
      `attendance_ingestion_event` table, `UNIQUE (tenant_id, source,
      source_event_id)` is the actual dedup mechanism, not an
      application-level pre-check - proven correct under concurrency by
      construction (the database constraint, not application logic, is
      what two racing identical requests both hit).
- [x] The `AttendanceRecord` write and the ledger insert run in one
      transaction (ADR-0075's revised design) - a unique-violation or a
      clock-out conflict rolls both back together automatically, so no
      manual compensating-delete code exists in this service at all.
- [x] Every read/write goes through `withTenantConnection`
      (`src/database/with-tenant-connection.ts`), which binds RLS's
      `app.current_tenant_id` GUC per request - without it every query
      silently fails closed or is rejected outright.
- [x] `clock_in` creates a new `AttendanceRecord`; `clock_out` closes the
      employee's currently-open one (`clock_out_at IS NULL`,
      `WHERE`-guarded `UPDATE` so a concurrent double-close is detected as
      a conflict, not silently overwritten) or is rejected `409` if none
      exists (`NoOpenAttendanceRecordError`) - never fabricated.
- [x] Exception detection against real `ShiftAssignment` data
      (`AttendanceExceptionDetectionService` + `ScheduleServiceClient`,
      own copy of intraday's ADR-0064 client): `unscheduled_work` (no
      covering shift), `late` (clock-in past grace period),
      `early_leave` (clock-out before grace period, only when the record
      isn't already flagged) - all real, not stubbed.
- [x] The `ScheduleServiceClient` call always happens outside any Postgres
      transaction/lock, in both the clock-in and clock-out paths.
- [x] Standard REST error envelope extended: `INVALID_SIGNATURE` (401),
      `UPSTREAM_UNAVAILABLE` (503), `NO_OPEN_ATTENDANCE_RECORD` (409),
      `ATTENDANCE_RECORD_CONFLICT` (409), registered in
      `DomainErrorFilter`.
- [x] Metrics: `attendance_ingestion_events_total{result}`
      (accepted/duplicate/rejected/upstream_unavailable),
      `attendance_ledger_insert_duration_seconds`.
- [x] Unit tests: exception-detection logic (late/early-leave/unscheduled,
      grace-period boundaries, the don't-clobber-an-existing-exception
      rule) against a mocked `ScheduleServiceClient`; ingestion-service
      duplicate detection, the clock-out conflict path, and
      upstream-unavailable handling against a mocked `DataSource`/
      `EntityManager`; HMAC guard (missing/malformed/stale/wrong-secret/
      tampered cases); the new migration's shape (table, the dedup unique
      constraint, the FK, RLS, SELECT/INSERT-only grants). No live Postgres
      or scheduling-service required to run `npm test`.
- [x] Verified against a real local Postgres end to end, not just unit
      tests: both migrations apply cleanly, and a real HTTP client sending
      correctly-HMAC-signed requests against the built app (with a stub
      `scheduling-service` on :8100) exercises clock-in (late-flagged),
      duplicate replay, clock-out (early-leave-flagged), an orphaned
      clock-out (409), and a bad signature (401) - all producing the
      expected status codes and response bodies. **This verification is
      what caught two real bugs the unit tests (against mocked
      repositories) could not have found**: (1) RLS silently rejecting
      every write because nothing bound `app.current_tenant_id` per
      request, and (2) the original lock-then-compensate design violating
      the ledger table's own FK by inserting it before the row it
      references existed. Both are fixed in the current design (see
      ADR-0075's revision note) - this line item is recorded explicitly so
      "unit tests pass" is never mistaken for "verified against a real
      database" in this module's phases going forward.

## Explicitly NOT done here (needs a later phase)

- [ ] **`no_show` detection.** Needs a proactive sweep job (a shift ended
      with no matching clock-in), not an event-driven check - this phase
      only reacts to events that arrive. See the design doc's assumption 5
      for why this isn't assigned to a specific phase yet.
- [ ] **Manual clock-event correction / `recordClockEvent` GraphQL
      mutation (§3.1).** This phase is the badge/biometric webhook path
      only - an orphaned or wrong `AttendanceRecord` has no correction path
      yet.
- [ ] **Per-tenant/per-`EmploymentPolicy` grace-period thresholds.**
      `ATTENDANCE_LATE_GRACE_MINUTES`/`ATTENDANCE_EARLY_LEAVE_GRACE_MINUTES`
      are flat env config, identical for every tenant.
- [ ] **A durable per-tenant webhook secret store.**
      `ATTENDANCE_WEBHOOK_SECRETS` remains a local env-config JSON map,
      the same unclosed gap Module 05's own Phase 1 flagged for itself.
- [ ] **Any `Leave*` table, `requestLeave`, or conflict-check logic.**
      Phase 3.
- [ ] **BullMQ, NATS, Redis.** Still entirely absent from this service -
      Phase 4/5 per Phase 1's own deferral, unchanged by this phase.
- [ ] **GraphQL (`attendanceExceptions` query).** Not built.
- [ ] **Load/throughput testing of the ingestion endpoint.** §0 frames this
      module as explicitly not high-throughput, so this isn't a release
      gate the way Module 05's 100k-agent test was - but it also means no
      such test has been run, and this phase's design should not be read
      as validated at any particular request volume.
- [ ] **Terraform for real Postgres/badge-vendor-integration provisioning,
      Vault for credential issuance.** Same gap already flagged in every
      prior module's own Phase 1 checklist.
- [ ] **In-process or gateway-level rate limiting on the ingestion
      endpoint, penetration testing / SOC2 / ISO27001, SAST / dependency
      scanning / SBOM.** Same explicit non-goals already stated
      platform-wide.
