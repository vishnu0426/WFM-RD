# Module 04 Phase 1 Production Readiness Checklist

Honest split between what this phase's code actually delivers and what is
genuinely infrastructure/process work belonging to other teams/phases (§0.5),
matching Module 01/02/03's phase-1 checklists' format and honesty bar. This
module carries the platform's highest engineering risk (§0) — this checklist
is deliberately conservative about what "done" means here.

## Delivered in this phase (application code)

- [x] Full DDL for every §2 entity (`ScheduleJob`, `Schedule`,
      `ShiftAssignment`, `ScheduleExplanation`, `ScheduleConflict`) plus the
      Phase-1-only `idempotency_keys` table, with `upgrade`/`downgrade`
      migrations.
- [x] Row Level Security on every `scheduling.*` table, reusing Module 01's
      exact `app.current_tenant_id` GUC convention (ADR-0002/0052) rather
      than a parallel mechanism.
- [x] New `agno_scheduling_app` DB role, scoped to `USAGE` on `scheduling`
      only — no access to `core`/`org`/`forecasting` (ADR-0052), proven by
      `tests/integration/test_rls_isolation.py`.
- [x] `shift_assignments` partitioned `RANGE` monthly on `shift_start`
      (ADR-0053), bootstrap partitions only (current month ± 1).
- [x] `ShiftAssignment.locked` is a `GENERATED ALWAYS` column derived from
      `assignment_source` (ADR-0054), proven un-writable-directly by
      `test_locked_column_cannot_be_set_directly`. §2.2 rule 1's invariant
      is structural, not merely a convention every future write path has to
      remember.
- [x] No cross-schema foreign keys — `forecast_run_id`/`employee_id`/
      `skill_id`/`affected_employee_id` are plain columns, consistent with
      the gRPC-contract boundary this phase does not yet build (Phase 6) but
      already commits to structurally.
- [x] Application-layer tenant guard (`TenantContext`/`tenant_scoped_session`)
      that fails closed with no bound context, same Python analogue of
      `TenantScopedRepository`/`TenantContextService` Module 03 already
      established for this platform.
- [x] `POST /v1/scheduling/jobs` / `GET /v1/scheduling/jobs/{jobId}` (§4.1),
      idempotency-key handling backed by a real unique constraint, standard
      error envelope, `X-Request-Id`, and a Pydantic-level date-range
      validator backstopped by a matching DB `CHECK` constraint.
- [x] `/healthz` (liveness) / `/readyz` (Postgres blocking, NATS reported
      non-blocking) — shipped now rather than deferred, per §0.5's framing
      of "stuck in `solving` past SLO" as a day-one on-call signal for this
      module.
- [x] NATS JetStream publisher skeleton: connection lifecycle + idempotent
      stream bootstrap (`AGNO_SCHEDULING`, subject
      `agno.scheduling.job.completed.v1`) are real and tested;
      `publish_job_completed` itself is not called anywhere yet (nothing
      completes a job in this phase).
- [x] Unit tests (tenant context fail-closed/isolation, error envelope,
      middleware, schema validation) + integration tests (RLS + guard
      against real Postgres, full job-submission HTTP contract against the
      real app + NATS, the generated-column invariant against real Postgres).
- [x] `scripts/init-roles.sql`/`.gitignore` updated additively (new
      `scheduling` schema/role, no `docker-compose.yml` change needed since
      Module 03's `nats` service is reused as-is).
- [x] Verified end-to-end against a real shared Postgres (the same instance
      Module 03 already runs against) and a real local NATS+JetStream
      broker — migration applied, RLS/generated-column/cross-schema-denial
      invariants proven against real Postgres, full unit (18) and
      integration (12) suites green, `ruff`/`mypy` clean. This pass caught
      and fixed one real bug: Alembic's default `public.alembic_version`
      table is shared, unscoped, across every Python service in this
      database — this module's migration failed outright against Module
      03's existing revision history until `migrations/env.py` was scoped to
      `version_table_schema="scheduling"` (see the design doc's assumption
      8). Module 03's own `env.py` still has this latent gap; it happens to
      not matter today only because no third Alembic-tracked revision has
      collided with it yet.

## Explicitly NOT done here (needs a different owner or a later phase)

- [ ] **Anything resembling a constraint model.** No CP-SAT integration, no
      hard constraints (§3.1), no soft constraints (§3.2), no fairness
      bound (§3.3). This is the module's actual IP and its actual legal-
      liability surface — none of it exists yet. `POST /v1/scheduling/jobs`
      creates a row at `status: queued` and nothing ever moves it forward.
      Do not treat this phase's passing tests as evidence about constraint
      correctness; there is no constraint logic under test yet.
- [ ] **The `SchedulingDataProvider`/`SchedulingJobService` gRPC contracts.**
      §4.3's mid-solve pull pattern (the reason this module can scale to
      100k+ employees without a bulk upfront payload) does not exist yet —
      Phase 6.
- [ ] **Terraform for real Postgres/NATS provisioning, Vault for credential
      issuance.** Same gap already flagged in Module 01/02/03's own Phase 1
      checklists — not re-litigated per module. `agno_scheduling_app`'s
      password is a static placeholder in `.env.example`.
- [ ] **`pg_partman` (or equivalent) for `shift_assignments` partition
      rotation.** This migration creates three fixed local-dev partitions;
      nothing creates next month's partition automatically. Same accepted
      gap as `audit_log`/`forecast_data_points`, now inherited by a third
      table.
- [ ] **The 100k+ employee load test (§0.5, §7.1).** Explicitly named a
      release-gate artifact in the module prompt, not a nice-to-have — and
      explicitly *not* satisfied by this phase's partitioning decision.
      Partitioning is necessary infrastructure for that test to have a
      chance of passing; it is not the test itself. Cannot be run
      meaningfully before Phase 2+ gives this module something to load-test
      in the first place.
- [ ] **A CI check diffing `app/db/models.py` against the migration SQL** —
      same accepted-but-unclosed gap ADR-0016 already names for Module 03,
      now inherited here.
- [ ] **Zero-downtime deploy support (graceful draining, the stuck-in-
      `solving` reaper).** §7.2 asks for this to be built early, not
      deferred; it genuinely cannot be built before Phase 2 gives this
      service a long-running solve to drain gracefully around. Flagged as
      real Phase 8 scope, not silently dropped.
- [ ] **In-process or gateway-level rate limiting**, **penetration testing /
      SOC2 / ISO27001**, **SAST / dependency scanning / SBOM.** Same
      explicit non-goals already stated platform-wide for Phase 1 of every
      module.
