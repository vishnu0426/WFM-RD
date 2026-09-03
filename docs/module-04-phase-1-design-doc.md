# Module 04 Phase 1 Design Doc — Scheduling Engine: Schema & Job Scaffolding

**Status:** Approved for implementation
**Owner:** Scheduling pod (Module 04) — Principal Operations Research Engineer
+ Security/Compliance Architect sign-off on §2.2's structural invariants
**Scope:** §2 entities (`ScheduleJob`, `Schedule`, `ShiftAssignment`,
`ScheduleExplanation`, `ScheduleConflict`), RLS, partitioning, the FastAPI
service skeleton, the submit/poll REST contract (§4.1), and a NATS JetStream
publishing skeleton (§6) — no CP-SAT constraint model, no hard/soft
constraints, no fairness ledger, no infeasibility handling, no gRPC mid-solve
data pulls, no GraphQL (that's Node/Module 01's surface, fed by this
service's events, not built here). Depends on Module 01's `core` schema
(tenants, RLS convention) and reuses it unchanged; does not depend on Module
02's `org` schema or Module 03's `forecasting` schema directly — per §2/§4.3,
this module talks to `EmployeeService`/`ForecastService`/`PolicyService` over
gRPC contracts wired in a later phase, it does not read `org.*`/`forecasting.*`
tables.

## Problem

Module 04 is this platform's highest-engineering-risk module — the module
prompt is explicit that a wrong constraint model is "a legal-liability bug,
not a UX bug." That risk lives entirely in Phase 2+'s CP-SAT model. Phase 1's
job is narrower but still load-bearing: stand up the persistence layer and
async job-submission surface every later phase hangs off of, and get two
structural decisions right *before* any solver logic exists, because they are
much harder to retrofit once `ShiftAssignment` rows exist at volume:

1. **§2.2 rule 1 — a locked (human-touched) assignment must never be silently
   re-solved.** This is stated as a non-negotiable in the module prompt, on
   the same level as the hard constraints themselves. Phase 1 doesn't build
   the pre-solve partition step yet (that's Phase 5), but it does decide now
   how `locked` is derived, because that decision determines whether Phase
   5's partition step is provably correct or merely "written carefully" —
   see ADR-0054.
2. **§0.5's 100k+ employee scale is a day-one planning concern for this
   module specifically**, not a Phase 7 afterthought — `ShiftAssignment` is
   this module's highest-cardinality table (one row per employee per shift,
   regenerated on every re-optimization), so its partitioning strategy is
   decided now, the same way `audit_log` (ADR-0005) and
   `forecast_data_points` (ADR-0018) were — see ADR-0053.

Beyond those two, this phase follows the exact template Module 03 Phase 1
established for standing up a second Python service in this platform: reuse
Module 01's tenant-isolation contract unchanged rather than inventing a
parallel one, and ship a real (not stubbed) async job-submission HTTP surface
because "job scaffolding" is explicitly named Phase 1 scope in the module
prompt's own §9 build-phase list.

## Decision

FastAPI + SQLAlchemy 2.0 (async, `asyncpg`) + Alembic, identical split to
Module 03 (ADR-0016): ORM defines shape, migration SQL is the real DDL. A new
`scheduling` Postgres schema in the same `agno_wfm` database Module 01/02/03
already run against, owned by `agno_migrator`, served at runtime by a new
`agno_scheduling_app` role (ADR-0052) rather than reusing `agno_forecasting_app`
— same reasoning ADR-0017 gave for not reusing `agno_app`: independent
credential-rotation lifecycle, independent blast radius per service.

`shift_assignments` is `PARTITION BY RANGE (shift_start)` monthly (ADR-0053);
the other four tables are unpartitioned (their row counts are bounded by
job/publish/conflict frequency, not by employee count). `ShiftAssignment.locked`
is a Postgres `GENERATED ALWAYS AS (assignment_source <> 'auto_generated')
STORED` column (ADR-0054) — not an application-set flag — so §2.2 rule 1's
invariant is enforced by the schema itself, not by every future write path
remembering to set it correctly.

The submit/poll REST contract (§4.1) reuses the platform's `{ error: { code,
message, details } }` envelope (ADR-0015) and `Idempotency-Key` handling,
identical mechanism to Module 03's `idempotency_keys` table. `POST
/v1/scheduling/jobs` creates a real `ScheduleJob` row and holds it at
`status: queued` forever in this phase — nothing consumes the queue (CP-SAT
solving is Phase 2+), so this is observable, testable job scaffolding, not a
stub: the row it creates, the idempotency behavior, and the NATS skeleton's
connection/stream bootstrap are all real and tested, only "something solves
the schedule" is out of scope.

No cross-schema foreign keys exist anywhere in this migration.
`ScheduleJob.forecast_run_id`, `ShiftAssignment.employee_id`/`skill_id`, and
`ScheduleConflict.affected_employee_id` are plain `uuid` columns — referential
correctness for those ids is the gRPC contract's job (wired in Phase 6),
never a literal SQL `REFERENCES` across a bounded-context boundary this
platform otherwise enforces everywhere else (ADR-0052).

## Blast radius

- Purely additive: a new schema in an existing database, a new Postgres
  role, a new NATS stream/subject namespace on the already-running broker,
  a new deployable process. Zero changes to any Module 01/02/03 table,
  migration, or running code path.
- `scripts/init-roles.sql` gains the `scheduling` schema + `agno_scheduling_app`
  role, additive and backward compatible with the existing `docker-compose up`
  workflow. No `docker-compose.yml` change is needed — Module 03 already runs
  a JetStream-enabled `nats` service this module reuses (same broker, its own
  stream `AGNO_SCHEDULING` / subject prefix `agno.scheduling.>`).
- No deployed traffic yet. `POST /v1/scheduling/jobs` creates a real
  `ScheduleJob` row and holds it at `status: queued` forever — nothing
  consumes the queue.

## Rollback plan

Every Alembic migration has a paired `downgrade()`, ending in `DROP SCHEMA
scheduling CASCADE`. Nothing external depends on this schema yet (no solver,
no gRPC callers), so rollback is a non-event now — this stops being true
once Phase 2+ puts real solve jobs and Phase 6's gRPC pulls against these
tables.

## Explicit assumptions (spec was ambiguous or silent here)

1. **Same Postgres database, new schema — not a separate database, not a
   third `agno_*_app` role reusing an existing one.** Same reasoning as
   ADR-0017, restated as ADR-0052 for this module specifically.
2. **`ShiftAssignment.locked` is a generated column, not an application-set
   boolean.** The module prompt states rule 1 as non-negotiable; a generated
   column makes the invariant structurally true rather than merely tested —
   see ADR-0054. This is a stronger guarantee than the module prompt
   literally asked for, and is called out here because it constrains how
   Phase 5's write paths (manual override, swap-acceptance) must be built:
   they set `assignment_source`, never `locked` — any future code that tries
   to set `locked` directly gets a Postgres error, not silently-ignored input.
3. **`shift_assignments` is partitioned from Phase 1, before any row exists.**
   Consistent with `audit_log`/`forecast_data_points` precedent — partitioning
   an empty table now is free; partitioning a table with real rows later is
   an outage-risk migration. Bootstrap partitions only (current month ± 1),
   same accepted gap as those two precedents (ADR-0053) — production
   partition rotation is out of scope, flagged in the readiness checklist.
4. **`constraint_config` is an unvalidated `dict`/`jsonb` in this phase.**
   §2.2 rule 3 calls it "tenant-configurable jsonb," and §3.3's fairness
   tolerance/soft-weight shape isn't decided until Phase 3. Phase 1 accepts
   any JSON object (including `{}`, meaning "platform defaults") rather than
   inventing a schema now that Phase 3 would likely have to change anyway.
5. **`ScheduleJob.date_range_end >= date_range_start` is enforced twice**: a
   Pydantic `model_validator` at the API boundary (a normal 422, not an
   opaque 500) and a matching Postgres `CHECK` constraint (defense in depth
   for any future write path that bypasses the FastAPI layer — matching this
   platform's general posture toward DB constraints as a backstop, not the
   primary validation path).
6. **No gRPC surface in this phase.** §4.3 defines both a Node→Python job
   submission gRPC (`SchedulingJobService`) and a Python→Node mid-solve data
   pull (`SchedulingDataProvider`). Neither is needed until something
   actually solves a job (Phase 2 for the former's REST equivalent already
   covers submission; Phase 6 for the latter). Building gRPC scaffolding with
   nothing behind it yet would be speculative infrastructure this phase's
   own non-negotiables (§0's "no half-finished implementations") argue
   against.
7. **NATS stream name `AGNO_SCHEDULING`, subject
   `agno.scheduling.job.completed.v1`**, bootstrap-on-startup, idempotent —
   identical mechanism to Module 03's own `AGNO_FORECASTING` stream, same
   broker.
8. **Alembic's version table is scoped to `scheduling.alembic_version`, not
   the default `public.alembic_version`.** Discovered by actually running
   `alembic upgrade head` against the same shared Postgres Module 03 uses:
   Module 03's `env.py` never set this, so its revision history lives in
   `public.alembic_version` unscoped — harmless while it was the only
   Alembic-based service, but this module's own `alembic upgrade head`
   failed outright (`Can't locate revision identified by '0004'`) reading
   Module 03's revision state out of that same shared table. Fixed here via
   `version_table_schema="scheduling"` in `migrations/env.py`; Module 03's
   own `env.py` was left unchanged (out of this phase's scope to retrofit),
   but any future Python service added to this platform should set this
   from its own Phase 1, not rediscover the collision.
9. **`ScheduleExplanation` and `ScheduleConflict` ship as tables with no
   endpoints yet.** Both are in §2's entity list; §4.2 describes GraphQL
   surfaces for them that are Node/Module 01's job to build once this
   service emits real data (Phase 4 for conflicts, Phase 6 for explanations).
   The tables exist now so those phases don't need a schema migration to
   catch up.

## Out of scope for this phase (do not build yet)

- CP-SAT constraint model, hard or soft constraints, single-site or
  decomposed — Phase 2/3/7.
- `FairnessLedger` cross-run read model — Phase 3.
- Infeasibility relaxation ordering, structured explanation payload, human-
  approval gate (§5) — Phase 4.
- Manual-override/locked-assignment pre-solve partition *logic* (the schema
  support for it — the `locked` generated column — ships now; the partition
  step that reads it does not) — Phase 5.
- `SchedulingDataProvider` gRPC (mid-solve pulls into Module 01/02/03) and the
  Module 10 explanation-generation handoff — Phase 6.
- Decomposition strategy, commercial-solver fallback trigger, the 100k+
  employee load test itself — Phase 7. (The *partitioning* decision that
  scale motivates is Phase 1 scope per ADR-0053; the load test that proves
  the whole system holds up at that scale is not.)
- Graceful draining, the stuck-in-`solving` reaper process — Phase 8.
- GraphQL surface (`requestSchedule`, `publishSchedule`, `overrideAssignment`,
  `resolveConflict`, subscriptions) — Node/Module 01's surface, fed by this
  service's NATS events; not built in this repo path at all in this phase.
