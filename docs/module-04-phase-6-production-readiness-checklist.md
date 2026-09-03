# Module 04 Phase 6 Production Readiness Checklist

Same honesty bar as Phases 1-5. This phase is unusual: it required real
changes in *two other services* (`forecasting-service`, and Module 01/02's
own `src/`) just to verify Module 04's own work against real infrastructure
- both are called out explicitly below, separate from what this module
itself delivers.

## Delivered in this phase (application code)

- [x] `ForecastService.GetForecastRequirements` — a real, new gRPC server in
      `forecasting-service` (`grpc.aio`, unary), reading Phase 5's already-computed
      `ForecastDataPoint.required_headcount`. Verified against real Postgres
      via a real `grpc.aio.Server`/client (`tests/grpc/`, 5 tests: found run
      with real requirements, `NULL` headcount serialized as empty string
      not `"0"`, not-found run, still-`running` run, wrong-tenant run).
- [x] `app/grpc_clients/` in scheduling-service — real clients for
      `EmployeeService.GetSchedulableEmployees`/`GetEmployeeSkillMatrix`,
      `PolicyService.GetActivePolicy` (×3, one per employment `policy_type`
      this module needs), `ForecastService.GetForecastRequirements`, plus a
      shared retry/backoff helper (`app/grpc_clients/retry.py`, 5 dedicated
      unit tests against real `grpc.aio.AioRpcError` instances: succeeds
      first try, retries on `UNAVAILABLE`/`DEADLINE_EXCEEDED` and recovers,
      never retries `INVALID_ARGUMENT`, exhausts after 4 attempts and
      raises a structured error).
- [x] `ScheduleJobRequest.roster`/`.policy`/`ShiftSlotInput.requiredHeadcount`
      all independently optional - omitted triggers a gRPC pull, supplied
      always wins outright, no merge. Wire-compatible: every existing
      caller's request body means exactly what it meant before this phase.
- [x] Forecast-derived shift headcount: max across every overlapping
      forecast interval, never a guessed default - an undeterminable
      headcount (forecast not found, or no overlapping interval with a
      computed value) is a clear `422 SHIFT_HEADCOUNT_UNDETERMINED`.
- [x] `UpstreamDataUnavailableError` (503): a gRPC pull that exhausts
      retries never creates a `ScheduleJob`/`IdempotencyKey` row - a retried
      `POST` with the same `Idempotency-Key` after the upstream recovers is
      a fresh attempt, not a replay of a failure.
- [x] `agno.scheduling.job.completed.v1` actually publishes now -
      `app/events/nats_publisher.py::publish_job_completed` existed since
      Phase 1 as unwired scaffolding; this phase wires it into every
      terminal solve outcome across `create_job`/`approve_relaxation`/
      `reoptimize_schedule`, not just `completed`.
- [x] `POST /v1/scheduling/jobs/{jobId}/explanation` (upserts) +
      `GET /v1/scheduling/jobs/{jobId}`'s `explanation` field - the
      write/read halves of the Module 10 handoff this module owns per §1's
      mandated-stack table ("requests it, doesn't own the LLM call").
- [x] **Real, end-to-end proof against the actual running platform** - not
      stubs, not a second fake implementation of either contract:
  - A job submission omitting `roster`+`policy` entirely, solved
    successfully with an employee seeded directly into Module 01/02's own
    live database, and policy values (11h rest, 4-day max consecutive,
    120-720min shift length) pulled from real `core.policies` rows.
  - A shift omitting `requiredHeadcount`, correctly staffed for its *peak*
    forecast interval (2 people, not the first interval's 1) pulled from a
    real `forecasting.forecast_data_points` row.
  - An explicitly-supplied roster/policy winning outright over a decoy
    employee seeded in Module 02's database that would have been pulled
    instead if the override hadn't taken precedence.
  - A real completion event received off a real NATS JetStream stream
    within the same test that triggered it.
  - Explanation submit → read-back → resubmit-upserts-not-duplicates → 404
    on a nonexistent job.
- [x] Every existing Phase 1-5 test (99) still passes unmodified - the
      optional-pull machinery is additive (every new field defaults to
      today's exact behavior when supplied).
- [x] `ruff`/`mypy` clean; full suite (112 tests: 99 pre-Phase-6 + 4 gRPC
      pull integration + 5 retry unit + 4 explanation/completion-event)
      passing against real Postgres, real NATS, the real Module 01/02 app,
      and a real `ForecastService`.

## Real bugs found and fixed outside this module's own code

Not Module 04's to own long-term - flagged here for their actual owners,
fixed because they blocked verifying Module 04's own Phase 6 work:

- [x] Module 01/02's `WebhookModule` provided but never exported
      `WebhookDeliveriesRepository` - `MetricsModule` couldn't resolve its
      dependencies, meaning the Node app **could not boot at all**, in any
      environment, until fixed (`exports` array, one line).
- [x] Module 01/02's `nest-cli.json` copied `.proto` assets to
      `dist/grpc/proto/`, but compiled JS (and therefore `join(__dirname,
      ...)` proto-path lookups) lands in `dist/src/grpc/proto/` - the gRPC
      server has likely never been reachable from *any* build this repo's
      own tooling produces, contradicting ADR-0021's own claim that this
      was already fixed. Fixed (`outDir: "dist/src"`).
- [x] `forecasting-service`'s `migrations/env.py` never scoped Alembic's
      version table - running its migrations against the shared Postgres
      was reading (and nearly overwriting) Module 04's own
      `scheduling.alembic_version` row. Fixed
      (`version_table_schema="forecasting"`).
- [x] Module 01/02's own TypeORM migration-tracking table has the same
      class of bug one level up (no `schema` on `DataSourceOptions` →
      landed in `scheduling` schema, not its own). Fixed (`schema: 'core'`
      added to `data-source.ts`) but **not re-verified end-to-end** - see
      below.
- [x] `core.policies`' CHECK constraint was never actually widened for the
      four employment policy types despite the migration file containing
      the correct statements - worked around with a direct `ALTER TABLE`
      matching the migration's own intent, not a full re-baseline.

## Explicitly NOT done here (needs a different owner or a later phase)

- [ ] **Module 01/02's migration-tracking corruption is not fully
      resolved.** The `schema: 'core'` fix was added but the migrations
      were never re-run end-to-end against a fresh database to confirm it
      actually produces a clean, correctly-scoped tracking table - this
      session's tests ran against an already-migrated, already-corrected-by-hand
      instance. Whether migrations `0001`-`0009`'s *other* DDL (skill
      decay, SSO, audit eventing schemas) actually applied for real, or
      share the same "tracking says yes, DDL says no" gap the policy-type
      constraint had, is a genuinely open question this phase did not
      investigate further - it's Module 01/02's own migration history to
      audit and re-baseline, not something to guess at from the outside.
- [ ] **The employment-policy `definition` JSON contract
      (ADR-0059 Decision 3) has no enforcement on Module 01/02's side.**
      Nothing validates that a tenant's `rest_period_minimum`/
      `max_consecutive_days`/`union_rule` policy rows actually match the
      field names this module expects - a mismatch fails soft to a
      platform default rather than loud, which is the *safe* failure mode
      but also means a genuine tenant misconfiguration could go unnoticed
      for a long time. A shared schema (or Module 01-side validation)
      would close this; not built here.
- [ ] **`Employee.overtime_approved` has no source anywhere in the
      platform.** Every gRPC-pulled employee gets `overtime_approved:
      false` (the safe default) - Module 02's own `Employee` entity has no
      such column, so this can only be fixed by a Module 02 schema change,
      not anything on this module's side.
- [ ] **Leave/unavailability remains permanently request-supplied** - no
      change from every prior phase; Module 06 doesn't exist.
- [ ] **`ReoptimizeScheduleRequest` has no forecast-pull support** -
      `policy`/`shiftSlots` stay fully required there this phase (explicit
      scope decision, not an oversight).
- [ ] **Job submission (including the new gRPC pulls) is still fully
      synchronous inside the HTTP request** - unchanged, already-flagged
      gap since Phase 2, now with up to three more sequential network calls
      (roster, policy ×3, forecast) added to the worst case before a solve
      even starts. Phase 7/8's job is still to move this off the request
      thread.
- [ ] **No load/latency data on the gRPC pulls themselves** - retry/backoff
      is unit-tested for correctness, not for behavior under real network
      degradation or a genuinely overloaded upstream. Same "Phase 7's job"
      caveat as the rest of this module's scale claims.
- [ ] **`core_grpc_url`/`forecasting_grpc_url` have no service-discovery
      story** - hardcoded host:port config values, no DNS/mesh-based
      resolution, no mTLS, no retry-aware load balancing across multiple
      upstream instances. Matches this platform's existing gRPC posture
      elsewhere (ADR-0021's own "authenticate the calling service" gap) -
      not a new gap this phase introduces, but now with three targets
      instead of zero.
- [ ] **Decomposition, load testing at scale, zero-downtime deploys,
      graceful draining/reaper** - unchanged, still Phases 7-8.
