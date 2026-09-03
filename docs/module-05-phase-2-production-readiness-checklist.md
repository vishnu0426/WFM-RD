# Module 05 Phase 2 Production Readiness Checklist

Honest split between what this phase's code actually delivers and what is
genuinely infrastructure/process work belonging to other teams/phases (§0.5),
matching Phase 1's own format and honesty bar. This phase touches two
services (`intraday-service` and `scheduling-service`) — both halves are
covered below.

## Delivered in this phase (application code)

- [x] `scheduling-service`: `GET
      /v1/scheduling/employees/{employeeId}/shift-assignments?from=&to=`
      (ADR-0064), published-schedule-only, overlap-filtered, tenant-scoped —
      proven by a real integration test against Postgres/NATS
      (`test_employee_shift_assignments_api.py`), including a tenant-isolation
      case.
- [x] `scheduling-service`: `agno.scheduling.schedule.published.v1` /
      `agno.scheduling.assignment.changed.v1`, published from
      `publish_schedule`/`override_assignment` respectively, dedup'd via
      `Nats-Msg-Id` — proven by the same integration test subscribing and
      asserting exactly one matching event per call. Full existing
      `scheduling-service` suite (124 tests unrelated to pre-existing local
      credential drift, see "Explicitly NOT done" below) still green,
      `ruff`/`mypy` clean.
- [x] `intraday-service`: `IntradayRedisService.writeAgentLiveState`/
      `writeQueueLiveState` widened to `Partial<...Fields>` — proven by unit
      tests that a `scheduledActivity`-only write leaves
      `currentActivity`/`siteId`/`queueId` untouched, and vice versa.
- [x] `AgentStateChangedConsumerService`: real, durable, strictly-sequential
      JetStream consumer on `agno.intraday.agent.state_changed.v1.>`,
      writing exactly the four fields it owns, nak-and-redeliver on a Redis
      failure, term-not-redeliver on an unparseable payload — proven
      end-to-end against real local Redis/NATS (a signed webhook POST
      resulted in `AgentLiveState.currentActivity` landing in Redis via this
      consumer, not the ingestion path directly).
- [x] `SchedulePublishedConsumerService`/`AssignmentChangedConsumerService`:
      real, durable JetStream consumers on scheduling-service's own stream,
      tracking affected employees (TTL-refreshed marker) and triggering an
      immediate `ScheduledActivityService.refresh` — proven end-to-end by
      hand-publishing a `schedule.published.v1` message onto `AGNO_SCHEDULING`
      and confirming the tracked-employee key and `scheduledActivity` both
      appeared in Redis.
- [x] `ShiftStartPreloadSchedulerService`: real `@Cron('* * * * *')` tick,
      per-entity idempotent recheck, per-entity `try`/`catch` isolation,
      re-entrancy guard — proven by unit tests including the concurrent-tick
      no-op case.
- [x] `DurableJetStreamConsumer<TPayload>`/`bindDurableConsumer`: shared,
      real (not stubbed) lifecycle/provisioning mechanics underneath all
      three consumers — idempotent consumer provisioning (info-throws/add-
      creates, same idiom `scripts/provision-nats-streams.ts` already uses
      for streams).
- [x] Two ADRs (0064 in `scheduling-service`'s decision log, 0065 in
      `intraday-service`'s), written per §0.5's "write it down now, not once
      an extraction/scale problem is already underway" posture.
- [x] Unit test suite (14 new spec files/additions across both services'
      new logic — consumer `handlePayload` methods, `ScheduledActivityService`,
      `ScheduleServiceClient`, the scheduler, Redis partial-write and
      tracked-employee-registry round trips) — no live infra required to run
      `npm test`/`pytest` (the *unit* suites; the integration suites, as
      always in this repo, need real Postgres/NATS).

## Explicitly NOT done here (needs a different owner or a later phase)

- [ ] **Horizontal-scaling-safe per-employee ordering across multiple
      `intraday-service` replicas.** This phase's ordering guarantee
      (ADR-0063) holds for one running instance via strictly-sequential
      processing. Multiple replicas competing for the same durable consumer
      name would break that guarantee for employees whose messages land on
      different replicas. Explicit Phase 7 scope (load-test-driven
      partitioning), not solved here.
- [ ] **`reoptimize_schedule` publishing `assignment.changed.v1`.**
      (ADR-0064's consequences section.) A worker-driven reassignment
      without a human override in the loop does not immediately refresh
      those employees' `scheduled_activity` — it still catches up via the
      cron's own cadence, just not the moment the re-optimization
      completes. Requires wiring `scheduling-service/app/worker.py`'s
      reoptimize-completion path into `nats_publisher` — not done here.
- [ ] **A richer `scheduled_activity` taxonomy** (per-queue, per-activity-
      code) — blocked on scheduling-service's own data model, which
      currently has no activity-code field on `ShiftAssignment` at all.
- [ ] **Cross-service authentication between `intraday-service` and
      `scheduling-service`.** `ScheduleServiceClient` sends `X-Tenant-Id`,
      trusted exactly as much as scheduling-service's own
      `TenantContextMiddleware` already trusts it from any caller — no
      mTLS/service-JWT exists anywhere in this platform. Pre-existing
      platform-wide gap, not new to this phase, but now has a second
      caller depending on it.
- [ ] **A durable per-tenant webhook secret store** (Phase 1's still-open
      gap) and **`AdherenceEvent`/Postgres in `intraday-service`** (Phase 3)
      — unrelated to this phase, re-flagged here only so this checklist
      doesn't imply they were closed.
- [ ] **11 pre-existing `scheduling-service` integration test failures**
      (`test_rls_isolation.py`, `test_worker_and_reaper.py`,
      `test_grpc_data_pulls_api.py`, one `test_fairness_ledger_api.py`
      case) traced to local Postgres role-credential drift between `.env`
      and the running database for roles those specific tests connect with
      directly (bypassing the app's own connection pool, which authenticates
      fine) — reproduced identically with every change in this phase absent
      from the tree, so confirmed pre-existing, not a regression. Fixing
      local environment credential drift is out of scope for this phase's
      application-code changes; flagged here so it isn't mistaken for
      something this phase broke.
- [ ] **The 100k+-agent release-gate load test, chaos/game-day exercises,
      the full §6.1 degradation contract on a live-read API.** Same Phase 7
      scope named in Phase 1's own checklist — this phase gives the load
      test something real to exercise (an actual write/consume pipeline)
      but does not run it.
- [ ] **Terraform/Vault, rate limiting, penetration testing, SAST/SBOM.**
      Same explicit non-goals already stated platform-wide for every
      module's early phases — not re-litigated per phase.
