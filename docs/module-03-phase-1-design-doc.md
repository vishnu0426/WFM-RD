# Module 03 Phase 1 Design Doc — Forecasting Engine: Schema & Job Scaffolding

**Status:** Approved for implementation
**Owner:** Forecasting pod (Module 03)
**Scope:** §2 entities (`ForecastModel`, `ForecastRun`, `ForecastDataPoint`,
`SpecialEvent`, `ForecastAccuracyLog`, `ScenarioSimulation`, `DataQualityCheck`),
RLS, partitioning, the FastAPI service skeleton, the submit/poll REST contract
(§3.3), and a NATS JetStream publishing skeleton (§3.4) — no model training, no
data-quality gate *logic*, no cold-start fallback *logic* yet (those are Phase 2+),
no GraphQL (that's Node/Module 01's surface, fed by this service's events, not
built here). Depends on Module 01's `core` schema (tenants, RLS convention) and
reuses it unchanged; does not depend on Module 02's schema directly — per §5/§8,
this module talks to `EmployeeService`/`CalendarService` over their gRPC contracts
for headcount-conversion inputs, it does not read `org.*` tables.

## Problem

Module 03 is the first Python service in the platform. It needs a persistence
layer and a job-submission surface that: (a) can't be forced into the Node/
TypeORM mold (different language, different ORM, different process/deployment
unit), (b) reuses Module 01's tenant-isolation *contract* exactly — same
`app.current_tenant_id`/`app.is_platform_admin` Postgres GUCs, same RLS
`ENABLE`-not-`FORCE` posture, same fail-closed-on-unset-GUC behavior — rather than
inventing a parallel isolation mechanism a future cross-service audit would have
to reconcile, and (c) builds the two pieces of infrastructure the source spec
flags as "needs explicit design, not a later retrofit" — the `DataQualityCheck`
gate (§2.2) and the cold-start fallback (§2.3) — into the schema from day one,
even though their *logic* is explicitly Phase 2 scope.

Unlike Module 01/02 Phase 1, this phase also has to stand up a real HTTP surface
(§3.3's submit/poll contract) and an event-publishing skeleton (§3.4), because
"job scaffolding" is explicitly named in the source spec's own Phase 1 (§7).
Async job submission is the load-bearing contract the rest of this module hangs
off of; it can't be deferred to a later phase the way Module 01/02 deferred their
HTTP surfaces.

## Decision

FastAPI + SQLAlchemy 2.0 (async, `asyncpg` driver) + Alembic, with the exact same
"ORM defines shape, migrations are hand-written SQL" split Module 01 chose in
ADR-0001 — see ADR-0016. A new `forecasting` Postgres schema in the *same*
`agno_wfm` database Module 01/02 already run against (not a separate database),
owned by the existing `agno_migrator` role, served at runtime by a **new**
`agno_forecasting_app` role rather than reusing `agno_app` — see ADR-0017.

Six of the seven Phase 1 tables are unpartitioned (their row counts are bounded
by tenant × model-type × queue counts, not by an unbounded time series);
`forecast_data_points` and `forecast_accuracy_log` are `PARTITION BY RANGE`
monthly, the same strategy Module 01 chose for `audit_log` (ADR-0005) and for the
same reason — see ADR-0018.

The `DataQualityCheck` table and `ForecastRun.is_cold_start`/cold-start columns
ship now as schema only, per §2.2/§2.3's explicit instruction that these are
day-one design concerns. The concrete numeric thresholds and cold-start defaults
that Phase 2's gate logic will read are decided and recorded now (ADR-0019) so
Phase 2 has a spec to implement against rather than inventing numbers under
implementation pressure — the "no vague accuracy claims" rule from §0 applies
equally to "no vague data-sufficiency claims."

The submit/poll REST contract (§3.3) reuses Module 01/02's `{ error: { code,
message, details } }` envelope shape (ADR-0015) for cross-platform consistency,
even though this is a different language/framework with no shared code to import
it from — it's a convention match, not a code dependency. `POST
/v1/forecasting/jobs` requires `Idempotency-Key` per §3.3's table; Phase 1 adds
the storage this needs (`forecasting.idempotency_keys`) since nothing in the
platform has implemented idempotency-key handling yet.

## Blast radius

- Purely additive: a new schema in an existing database, a new Postgres role, a
  new NATS stream, a new deployable process. Zero changes to any Module 01/02
  table, migration, or running code path.
- `docker-compose.yml` gains a `nats` service (JetStream-enabled) and
  `scripts/init-roles.sql` gains the `forecasting` schema + `agno_forecasting_app`
  role — both additive, backward compatible with Module 01/02's existing
  `docker-compose up` workflow.
- No deployed traffic yet. `POST /v1/forecasting/jobs` creates a real
  `ForecastRun` row and holds it at `status: queued` forever in this phase —
  nothing consumes the queue (Ray orchestration is Phase 3+), so this is
  observable, testable job scaffolding, not a stub: the row it creates, the
  idempotency behavior, and the NATS skeleton's connection/stream bootstrap are
  all real and tested, only the "something trains a model" step is out of scope.

## Rollback plan

Every Alembic migration has a paired `downgrade()`, ending in `DROP SCHEMA
forecasting CASCADE`. As with Module 01/02 Phase 1, nothing external depends on
this schema yet (Ray/MLflow/model training don't exist), so rollback is a
non-event now — this stops being true once Phase 3 puts real training jobs
against these tables.

## Explicit assumptions (spec was ambiguous or silent here)

1. **Same Postgres database, new schema — not a separate database.** The source
   spec's architecture diagram implies a standalone Python service but says
   nothing about whether it gets its own database. A separate database would mean
   a second connection-pooling/backup/PITR surface for no isolation benefit RLS
   doesn't already provide, and would make the explainability provenance queries
   (§3.2 `forecastModelProvenance`) and any future cross-schema join harder for no
   reason. See ADR-0017.
2. **`pyproject.toml` + plain `pip`, no Poetry/PDM.** The source spec doesn't
   mandate a Python packaging tool. Poetry adds a lockfile-management decision
   with no functional requirement behind it at this phase; `pip install -e
   ".[dev]"` against a PEP 621 `pyproject.toml` is the minimum tooling that gets
   Phase 1 running. Revisit if dependency-resolution pain shows up once Ray/
   MLflow/PyTorch land in Phase 3+ (their transitive dependency graphs are large
   enough that a lockfile tool may earn its keep then).
3. **Tenant context is a `contextvars.ContextVar`, the Python analogue of
   Module 01's `AsyncLocalStorage`-backed `TenantContextService`.** Same
   fail-closed contract: `TenantContext.require_tenant_id()` raises
   `TenantContextMissingError` if nothing bound it. Same placeholder caveat as
   ADR-0014: a `TenantContextMiddleware` reads `X-Tenant-Id`/`X-Actor-Id`/
   `X-Actor-Type`/`X-Platform-Admin` directly off the request with no JWT
   validation behind it yet, because none exists anywhere in the platform yet
   (Module 01's own Phase 2 JWT work is still open).
4. **`agno_forecasting_app` is a new DB role, not a reuse of `agno_app`.** See
   ADR-0017. Keeps `GRANT`-level blast radius and audit trail scoped per
   deployable service, matching the reasoning (if not the letter) of ADR-0002's
   two-role split for `audit_log`.
5. **Idempotency keys are stored, not just documented.** `POST
   /v1/forecasting/jobs` with a previously-seen `(tenant_id, idempotency_key)`
   pair returns the original `jobId`/status instead of creating a second
   `ForecastRun`, via a unique constraint on
   `forecasting.idempotency_keys(tenant_id, idempotency_key)` mapping to the
   `forecast_run_id` it produced. No TTL/expiry job exists yet in this phase —
   flagged in the production readiness checklist as future retention work, the
   same category of gap `audit_log` partition rotation is for Module 01.
6. **`ScenarioSimulation` ships as a table with no endpoint yet.** §3.3 lists
   `POST /v1/forecasting/scenarios` but §7 scopes scenario simulation to Phase 6.
   The table exists now (it's in §2's entity list) so Phase 6 doesn't need a
   schema migration to catch up; no route is mounted for it in this phase.
7. **NATS stream name `AGNO_FORECASTING`, subject `agno.forecasting.run.completed.v1`**,
   created by an idempotent bootstrap function run at service startup (`add_stream`
   is a no-op if the stream already exists) rather than an out-of-band ops step —
   there's no separate infra-provisioning story for NATS streams yet anywhere in
   the platform, so this service owns its own stream's existence.
8. **`ForecastDataPoint.required_headcount` is nullable in this phase's schema.**
   §5/Phase 5 scopes the Erlang C/X computation; the column exists now (it's in
   §2.1's literal field list) so Phase 5 populates it rather than migrating for
   it, matching the same "schema now, logic later" split as `EmployeeSkill.decayScore`
   in Module 02 Phase 1.

## Out of scope for this phase (do not build yet)

- `DataQualityCheck` gate *logic* (the actual volume/gap/outlier checks) — Phase 2.
- Cold-start similarity-fallback *logic* (queue similarity scoring, seeding a
  forecast from similar queues) — Phase 2. Only `ForecastRun.is_cold_start` and
  the `DataQualityCheck` table exist now.
- Ray orchestration, MLflow artifact tracking, any model training/inference
  (SARIMA/Prophet/LightGBM/TFT) — Phases 3, 4, 8.
- Erlang C/X `required_headcount` computation — Phase 5.
- `ScenarioSimulation` endpoint — Phase 6.
- `ForecastAccuracyLog` population, `SpecialEvent` tagging feeding retraining —
  Phase 7.
- GraphQL surface (`forecastRun`, `latestForecast`, `forecastModelProvenance`,
  subscriptions) — Node/Module 01's surface, fed by this service's NATS events;
  not built in this repo path at all in this phase.
- gRPC calls to Module 02's `EmployeeService`/`CalendarService` — not needed
  until headcount-conversion inputs matter (Phase 5).
- GPU/TFT entitlement enforcement — Phase 8, once a TFT training path exists to
  gate.
