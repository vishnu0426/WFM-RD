# Module 06 Phase 8 Production Readiness Checklist

Same honesty bar as Phases 1–7. **This is the final phase of Module 06's
8-phase build** - this checklist also verifies the module's second `@Cron`
job class and second core gRPC client compose correctly with everything
Phases 1–7 already shipped, not just this phase's own code in isolation.

## Delivered in this phase (application code)

- [x] `AbsencePatternDetectionJob`: three heuristics matching §2.1's exact
      `AbsencePatternType` values, `@Cron('0 4 * * *')`, re-entrancy
      guarded, each step independently metriced and independently
      fault-isolated (a failure in one step, or one tenant within the
      holiday step, does not block the others).
- [x] `CalendarGrpcClientService`/`CalendarGrpcClientModule` - this
      service's second gRPC client, calling core's real, already-working
      `CalendarService.GetWorkingTimeRules`.
- [x] `acknowledgeAbsencePattern` (`POST /v1/leave/absence-patterns/:id/acknowledge`) -
      404/409 correctly modeled, `backdatedApprovedBy`-style single-actor
      write.
- [x] `GET /v1/leave/absence-patterns` (unacknowledged only, `detected_at
      DESC`) - matches Phase 1's own pre-built partial index.
- [x] Four new metrics (`absence_pattern_detection_runs_total{step,result}`,
      `absence_patterns_detected_total{pattern_type}`,
      `absence_pattern_acknowledgements_total{result}`).
- [x] Unit tests: 4 new tests for `CalendarGrpcClientService`, 3 for
      `AcknowledgeAbsencePatternService`, 1 for `ListAbsencePatternsService`,
      7 for `AbsencePatternDetectionJob` (step ordering, per-step success/
      error metrics, per-tenant holiday-step isolation, re-entrancy guard).
      Node-side total: 117 tests across 22 suites, all passing.
      `typecheck`/`lint`/`build` all clean.
- [x] `docs/module-06-runbook.md` (operational reference spanning all 8
      phases) and `observability/grafana-dashboard-module-06.json` -
      mirroring `module-05-runbook.md`/`grafana-dashboard-module-05.json`'s
      established per-service-dashboard convention.

## Verified against real infrastructure end to end

- [x] Real local Postgres, seeded via the platform's own real demo-data
      seed script (not synthetic-only fixtures) - the demo tenant's real
      `WorkingTimeCalendar` (holidays 2026-01-01, 2026-07-04, 2026-12-25)
      was used as-is, not re-created for this test.
- [x] A real, built core service serving real `CalendarService.GetWorkingTimeRules`
      responses, called via `@nestjs/microservices`' `ClientProxyFactory.create(...)`
      directly against the live process - not a mocked stub.
- [x] `frequency_threshold`: 12 one-day approved requests within 90 days
      (threshold 10) correctly detected, `confidence = 0.60`
      (`12 / (10*2)`), matching the documented formula exactly.
- [x] `recurring_day_of_week`: 6 approved single-day requests, all on
      Mondays, correctly detected, `confidence = 1.00` (100% concentration
      on one day), matching exactly.
- [x] `pre_post_holiday`: two approved requests, one ending the day before
      a past holiday (2026-07-04) and one starting the day after a future
      holiday (2026-12-25), correctly detected together (`cnt = 2 >=
      threshold 2`), `confidence = 0.50`, matching exactly.
- [x] Idempotency: re-running the full job with all three patterns already
      unacknowledged correctly detected 0 new rows across all three steps.
- [x] Acknowledgement-gated re-detection, verified as a real behavior, not
      assumed: acknowledged the `frequency_threshold` pattern via the real
      HTTP endpoint, re-ran the job, and confirmed a **fresh** unacknowledged
      row was created for the same employee/pattern type (the underlying
      behavior was still ongoing) - proving §2.2 rule 4's gate is wired
      end to end, not just present in the schema.
- [x] REST surface verified live: `GET /v1/leave/absence-patterns` (correct
      ordering and unacknowledged-only filtering), `POST .../acknowledge`
      (success, `409` on double-acknowledge, `404` on a missing id).
- [x] Confirmed the new Prometheus counters increment correctly against
      every scenario above.

## Two real bugs this verification caught (not hypothetical)

- **`pre_post_holiday`'s calendar-lookup window silently missed
  future-dated requests' holidays.** An earlier version fetched holiday
  data only through `toDate: today`, while the `leave_request` query it
  feeds has no upper bound on `date_range_start` (a deliberate choice - an
  approved future-dated request is real request-timing signal). The first
  real-infra test run detected 0 patterns where 1 was expected; tracing it
  down showed the request adjacent to the *future* holiday
  (2026-12-25) never had a chance to match, because that holiday was never
  fetched. Fixed by extending the calendar-lookup window symmetrically
  (`today ± windowDays`) instead of only backward - re-verified correct
  immediately after.
- **(Confirmed non-bug, recorded per this module's own "verify the exact
  runtime, not an approximation" discipline)**: this service's gRPC client
  wiring was deliberately tested via `ClientProxyFactory.create(...)`
  against the real running core process, the same category of check
  ADR-0079's audit client verification used - not assumed correct because
  the analogous Phase 6 client worked.

## Module 06 close-out (all 8 phases)

- [x] All 8 phases' unit test suites still pass together in one run (117
      tests, 22 suites) - no regression introduced by this final phase.
- [x] `docs/module-06-runbook.md` written, covering: RLS/cross-tenant job
      reasoning (both `@Cron` jobs), all cross-service dependencies (core
      `AuditService`/`CalendarService` gRPC, scheduling-service REST,
      NATS, Redis/BullMQ), and a scenario-by-scenario troubleshooting
      guide mirroring `module-05-runbook.md`'s structure.
- [x] `observability/grafana-dashboard-module-06.json` written, covering
      every metric introduced across all 8 phases.

## Explicitly NOT done here (permanent gaps or genuinely out of scope)

- [ ] **`no_show` pattern detection.** Not one of §2.1's three
      `AbsencePatternType` values - see the design doc's explicit
      assumption 1.
- [ ] **Real notification delivery of detected patterns.** No delivery
      pipeline exists anywhere in this platform.
- [ ] **GraphQL.** Never triggered by any of the 8 phases - every mutation
      in this module has a REST path instead.
- [ ] **Any accrual-rate/new-period-generation engine** (Phase 7's own
      flagged gap, unaffected by and not revisited in this phase).
- [ ] **A separate worker process, TLS/mTLS, Terraform provisioning, Vault
      credential issuance, rate limiting, penetration testing / SOC2 /
      ISO27001, SAST / dependency scanning / SBOM.** Same explicit
      non-goals stated platform-wide for every phase of every module.
