# Module 06 Phase 1 Production Readiness Checklist

Honest split between what this phase's code actually delivers and what is
genuinely a later phase's work, matching every prior module's phase-1
checklist format and honesty bar. §0's own framing — "lower engineering
risk... resist the temptation to over-engineer it" — is why this phase's
delivered list is short and its explicitly-deferred list is long: there is
no request path, no cross-service call, and no workflow logic in this phase
at all, by design.

## Delivered in this phase (application code)

- [x] Full §2.1 schema — `attendance_record`, `leave_type`, `leave_balance`,
      `leave_request`, `absence_pattern` — in one migration
      (`1700000600000-InitialAttendanceLeaveSchema.ts`), new `attendance_leave`
      schema/`agno_attendance_leave_app` role (ADR-0073), RLS
      `tenant_isolation` policy on all five tables (ADR-0002 convention,
      unchanged), tenant-id-first indexes, `varchar`+`CHECK` enums
      (ADR-0003).
- [x] §5.1's `is_backdated`/`backdated_reason`/`backdated_approved_by` and
      §5.2's `carryover_days_in`/`carryover_expiry_date`/
      `LeaveType.carryover_rules` shipped in this migration, not a later
      ALTER — including a schema-level `CHECK` making "backdated requires a
      reason" structurally impossible to violate
      (`leave_request_backdated_reason_required_check`), not just an
      application-layer rule.
- [x] `LeaveBalance`'s composite PK matches §2.1 exactly and is the
      row-lock granularity ADR-0074 designs Phase 3's concurrency-safe
      `pending_days` enforcement around — decided and documented now so
      Phase 3 isn't guessing at schema shape under its own deadline.
- [x] TypeORM entity classes for all five tables (`src/attendance/entities/`,
      `src/leave/entities/`), each backed by a TS `enum` for its
      `varchar`+`CHECK` columns.
- [x] Grants are least-privilege: `agno_attendance_leave_app` gets
      `SELECT, INSERT, UPDATE` only, no `DELETE` anywhere (nothing in this
      module's domain hard-deletes), no `CREATE` on the schema.
- [x] `/healthz` (liveness, no dependency checks) / `/readyz` (Postgres
      `SELECT 1`-blocking, `degraded` on failure) / `/metrics` (Prometheus
      text exposition: `http_request_duration_seconds`/`_total`, plus
      `attendance_leave_approval_propagation_duration_seconds` declared now
      against §0.5's SLO even though nothing records into it until Phase 5).
- [x] Standard REST error envelope (`{ error: { code, message } }`) via
      `DomainErrorFilter`, tenant-context header-trust placeholder
      (ADR-0014's convention) via `TenantContextMiddleware`/`Service`.
- [x] OpenTelemetry auto-instrumentation wired at boot, same import-order
      constraint and no-op-safe-without-a-collector posture as every other
      service's `tracing.ts` in this platform.
- [x] `scripts/init-roles.sql` additively gains `agno_attendance_leave_app`
      and the `attendance_leave` schema block; `observability/prometheus.yml`
      additively gains the `agno-wfm-attendance-leave-service` scrape job —
      every existing role/schema/job entry untouched.
- [x] Two ADRs (0073 schema/role, 0074 leave-balance row-lock concurrency
      strategy), written now per this platform's Phase 1 convention, not
      deferred until Phase 3's enforcement code is already under way.
- [x] Unit test coverage for entity/migration shape (composite PK, the
      backdated-reason `CHECK`, enum value sets) — no live Postgres required
      to run `npm test`.
- [x] No `docker-compose.yml` change needed — this service boots and serves
      `/healthz`/`/readyz`/`/metrics` against the already-running `postgres`
      container docker-compose already provisions for Module 01/02, once
      `npm run migration:run` has been run against it.
- [x] Verified against a real local Postgres, not just unit tests:
      `scripts/init-roles.sql` applies cleanly, `migration:run` executes end
      to end, the built app boots and serves `/healthz`/`/readyz`/`/metrics`
      using the least-privilege `agno_attendance_leave_app` role, RLS
      actually rejects a cross-tenant read, and the
      `leave_request_backdated_reason_required_check` constraint actually
      rejects a backdated insert with no reason. This surfaced one
      pre-existing, platform-wide (not Module-06-specific) `migration:revert`
      CLI gap — see the design doc's Rollback plan section for the full
      finding.

## Explicitly NOT done here (needs a later phase)

- [ ] **Any request path that actually writes these tables.** This phase is
      schema/migrations only — there is no controller, resolver, or service
      method anywhere in `attendance-leave-service/` yet. Do not treat a
      clean `migration:run` as evidence any mutation logic works; none
      exists to test.
- [ ] **Badge/biometric webhook ingestion, exception detection against
      `scheduled_shift_id`.** Phase 2.
- [ ] **`requestLeave`, the synchronous conflict-check calls into Module
      04/02, `conflict_flags` population, and the §2.2-rule-1 concurrency
      test ADR-0074 designs for.** The schema supports it; nothing exercises
      the lock yet. Phase 3.
- [ ] **BullMQ approval-chain workflow, `decideLeaveRequest`, balance
      transition on approval.** No Redis/BullMQ connection exists in this
      service yet — `.env.example` deliberately has no `REDIS_URL`. Phase 4.
- [ ] **`LeaveService.GetUnavailability`/`CheckScheduleConflict`
      gRPC/REST surface, the `agno.leave.request.approved.v1` NATS publish,
      and the re-pointing task back into `scheduling-service`'s interim
      leave-data stub (§3.4).** No gRPC server, no NATS client exists in
      this service yet. This is the phase that actually closes
      `scheduling-service`'s ADR-0059-flagged permanent gap — not this one.
      Phase 5.
- [ ] **§0.5's core SLO (leave-approval → Module 04 visibility propagation,
      p99 < 2s) is not measured, because nothing that could violate it
      exists yet.** The metric is declared (see above); it is not wired to
      anything. Do not read the metric's existence as evidence the SLO is
      met or even measurable today.
- [ ] **The backdated-leave elevated RBAC permission
      (`backdated_leave_entry:approve`, a new `resource` value in Module
      01's `RESOURCES` seed array) and payroll-resync flag.** The schema
      columns exist (`is_backdated`, `backdated_approved_by`); the
      permission itself is not seeded, and no code checks it. Phase 6.
- [ ] **The carryover rollover job (cap + set expiry) and the expiration
      job (remove expired carryover from `availableDays`).** Both are
      unbuilt `@Cron` services; `LeaveType.carryover_rules` is an unread
      jsonb column until then. Phase 7.
- [ ] **`AbsencePattern` detection logic and the `acknowledged_by` gate
      enforced end-to-end.** The table exists; nothing writes or reads it.
      Phase 8.
- [ ] **GraphQL surface** (`myLeaveBalances`, `leaveRequests`,
      `attendanceExceptions`, `absencePatterns`, all mutations). Not built
      at all in this phase — introduced alongside whichever phase first
      needs it (Phase 3 onward).
- [ ] **The §0.5 chaos scenario** (kill the gRPC/REST connection to Module
      04 mid-submission, verify fail-closed). Cannot be run meaningfully
      before Phase 3 gives this module a conflict-check call to kill.
- [ ] **Terraform for real Postgres provisioning, Vault for credential
      issuance.** Same gap already flagged in every prior module's own
      Phase 1 checklist — not re-litigated per module.
- [ ] **In-process or gateway-level rate limiting, penetration testing /
      SOC2 / ISO27001, SAST / dependency scanning / SBOM.** Same explicit
      non-goals already stated platform-wide for Phase 1 of every module.
