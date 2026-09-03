# Module 04 Phase 6 Design Doc — Scheduling Engine: Mid-Solve gRPC Data Pulls + Explanation-Generation Trigger

**Status:** Approved for implementation
**Owner:** Scheduling pod (Module 04)
**Scope:** §4.3 in full — mid-solve gRPC pulls into Module 01/02
(`EmployeeService`/`PolicyService`) and Module 03 (a new `ForecastService`),
replacing ADR-0055's request-supplied posture where a real source now
exists — plus the handoff to Module 10 for `ScheduleExplanation.summary_text`
(§1's mandated-stack table: "Module 04 requests it, doesn't own the LLM
call"). No decomposition (Phase 7), no zero-downtime deploys (Phase 8).

## Problem

§4.3 names three gRPC pulls this module needs mid-solve: `GetSchedulableEmployees`/
`GetEmployeeSkillMatrix` (Module 02), `GetActivePolicy` (Module 01),
`GetForecastRequirements` (Module 03) — "scope carried via `org_unit_id`/
`date_range`, not a bulk payload upfront." Grounding this in the *actual*
running platform, rather than an assumed one, surfaced four real gaps
before any of this module's own code could be written:

1. **`GetForecastRequirements` doesn't exist.** Module 01/02's gRPC server
   (`src/grpc/`) is real, already-running code with exactly the
   `EmployeeService`/`PolicyService` contracts this phase needs. Module 03
   (`forecasting-service`) has no gRPC surface at all.
2. **`EmploymentPolicy.definition`'s JSON shape was never pinned down
   anywhere** — `policy.proto` documents it as "arbitrary shape," and
   nothing in Module 01/02 validates it beyond `Record<string, unknown>`.
3. **No real leave/unavailability source exists anywhere in the platform** -
   unchanged by this phase, permanently, until Module 06 ships.
4. **The shared local Postgres this session runs against had real,
   dangerous migration-tracking bugs** in *both* other services this phase
   needs to talk to (detailed below) - not Module 04's code, but blocking
   verification of Module 04's own work until fixed.

ADR-0059 is the full record of every decision below; this doc covers the
same ground at the "why this shape, what it cost" level plus what was
actually found and fixed getting there.

## Decision: build `ForecastService` in `forecasting-service`, verify it in isolation

New `forecasting-service/app/grpc/proto/forecast.proto` +
`forecast_grpc_server.py` (`grpc.aio`, unary — see ADR-0059 Decision 1 for
why not server-streaming like `EmployeeService`), booted alongside the HTTP
app in `app/main.py`'s `lifespan`. `ForecastDataPoint.required_headcount`
(already computed by Phase 5's Erlang C pipeline) is exactly the data this
RPC serves — a read, not new computation.

**Verified in isolation, not through `app.main`.** `forecasting-service`'s
`app/main.py` transitively imports its full ML stack
(`torch`/`ray`/`mlflow`/`lightgbm`/`prophet`/`pytorch-forecasting`/
`lightning`) via its existing job/model routers — not installable in this
session's environment within a reasonable time/scope budget, and installing
it was never this phase's job (rebuilding forecasting-service's ML
environment is not "adding a gRPC surface"). `tests/grpc/` (deliberately
outside `tests/integration/`, whose `conftest.py` imports `app.ml.training`)
proves the new server for real: a real `grpc.aio.Server` on a real socket,
a real client, a real Postgres. `run_grpc_server_standalone.py` (new,
checked in) is the same server construction without the ML-importing HTTP
app around it — what this session's own cross-service integration tests
connected to, and a genuinely useful local-dev tool for anyone who wants
to run Module 04 against a real forecast pull without installing
forecasting-service's ML dependencies.

## Decision: omission triggers a pull; an explicit value always wins outright

`ScheduleJobRequest.roster`/`.policy` and `ShiftSlotInput.requiredHeadcount`
all become optional. Omitted → pulled via gRPC. Supplied → used exactly as
given, no merge. Two reasons, both load-bearing:

- **Zero regressions across 99 pre-Phase-6 tests.** Every one of them
  supplies roster/policy/shiftSlots explicitly; none needed a live Module
  01/02/03 gRPC server just to keep passing, because the pull only fires on
  *absence*, never as a new default behavior layered under existing calls.
- **A legitimate "what-if" path.** A Scheduler/Planner supplying a modified
  roster directly (e.g. "what if I had two more people") is a real
  operator override of what Module 02 has on file — the same trust-the-caller
  posture ADR-0058 already established for manual assignment overrides,
  applied here to whole-input overrides instead.

`leaveRecords` is **not** made optional — there is nothing to pull it from
(the permanent gap above). `ReoptimizeScheduleRequest` also keeps requiring
`policy`/`shiftSlots` in full (no pull support there this phase) — extending
it would mean the locked-shift-matching logic (ADR-0058) reasoning about a
shift whose headcount isn't known until after a forecast pull, deliberately
left out to keep this phase's scope bounded.

## Decision: forecast-derived headcount is the max across overlapping intervals; undeterminable is a loud 422, never a guess

A shift must be staffed for its peak interval, not its average one -
`derive_required_headcount` (`app/grpc_clients/forecast_client.py`) takes
the max `required_headcount` across every forecast interval the shift's own
`[start, end)` window overlaps. A forecast run that isn't found, or a shift
with no overlapping interval carrying a computed headcount at all, is
`422 SHIFT_HEADCOUNT_UNDETERMINED` — never silently defaulted to 1 or 0,
which could understaff a real shift without anyone noticing.

## Decision: the employment-policy JSON contract is this module's own to define

Only two of Module 01/02's four employment `policy_type` values map onto
anything `EmploymentPolicy` needs (`overtime_threshold` has no field here —
contracted hours sources from `Employee`, per §3.1's own table, not a
policy). This module fetches and defines the expected shape for exactly
three: `rest_period_minimum`, `max_consecutive_days`, `union_rule` (see
ADR-0059 Decision 3 for the exact field names). A tenant/admin creating one
of these policy rows via Module 01's `createEmploymentPolicy` mutation must
follow this shape — nothing in Module 01/02 validates it today, so a
mismatch fails soft to a platform default (Decision 4) rather than loud,
flagged as a real cross-module contract gap in the readiness checklist.

## Decision: gRPC pull failures never create a `ScheduleJob`

§4.3: "a transient gRPC failure mid-solve should retry the specific data
call, not abort the whole solve job." `app/grpc_clients/retry.py`: up to 4
attempts total (1 + 3 retries), 100ms/400ms/1600ms backoff, retrying only
`UNAVAILABLE`/`DEADLINE_EXCEEDED`. Exhausting retries (or any immediate
non-retryable RPC error) raises `UpstreamDataUnavailableError` (503) from
`_build_solve_input` — which runs, and can therefore fail, *before*
`job_service.create_job` is ever called. No `ScheduleJob`/`IdempotencyKey`
row is created on this path; a retried `POST` with the same
`Idempotency-Key` after the upstream recovers is a fresh attempt, the same
"rejected submission's transaction rolled back entirely" posture Phase 2's
own union-rule-rejection test already established.

## Decision: the explanation handoff is publish + store, nothing more

`app/events/nats_publisher.py::publish_job_completed` existed since Phase 1
as scaffolding with nothing calling it ("later phases wire a real trigger
into an already-proven publisher" — its own docstring). This phase is that
later phase: `job_service.create_job`/`approve_relaxation`/
`reoptimize_schedule` all publish `agno.scheduling.job.completed.v1` on
every terminal outcome (`completed`/`infeasible`/`failed`), not just
`completed` — an infeasible job's recorded relaxation option is equally
worth an explanation. New `POST /v1/scheduling/jobs/{jobId}/explanation`
(upserts) is where Module 10 calls back with a generated explanation; `GET
/v1/scheduling/jobs/{jobId}` now folds it into the response (§4.1's own
stated shape: `{ jobId, status, schedule?, explanation?, conflicts? }`).
This module never generates an explanation itself, per §1's mandated-stack
table and §10's explicit non-goal — `explanation` stays `null` until
something (Module 10, not built in this repo) actually subscribes and calls
back.

## Real bugs found and fixed while grounding this phase in the actual platform

None of these are Module 04's own code, but all of them blocked verifying
Module 04's own Phase 6 work against real infrastructure, so all were fixed
rather than worked around:

1. **`WebhookModule` (Module 01/02) provided `WebhookDeliveriesRepository`
   but never exported it** — `MetricsModule` (which imports `WebhookModule`
   for exactly this repository) failed to resolve it at boot, meaning the
   Node app could not start *at all*, in any environment, until this was
   fixed. One-line fix: add it to `WebhookModule`'s `exports` array.
2. **`nest-cli.json`'s proto-asset copy path didn't match where compiled JS
   actually lands.** Assets copied to `dist/grpc/proto/*.proto`; compiled
   `main.js` (preserving the `src/` prefix TypeScript's own output
   structure gives it) looked for `dist/src/grpc/proto/*.proto`. This is
   the exact gap ADR-0021's own "Consequences" section flagged as fixed
   ("without it... breaking in a built/production artifact") — except it
   turns out `npm run start:dev` (`nest start --watch`) produces a `dist/`
   folder too and hits the identical path mismatch, meaning the gRPC
   server has likely never actually been reachable in *any* environment
   this repo's own tooling produces, not just a hypothetical "production
   build" case. Fixed: `outDir: "dist/src"`.
3. **`forecasting-service/migrations/env.py` never scoped Alembic's
   version-tracking table**, the exact collision Module 04's own
   `migrations/env.py` already documented and fixed for itself ("a future
   Module 05 or later should do the same") — this file predates that
   comment and never got the fix. Running this service's migrations against
   the shared Postgres nearly advanced *Module 04's own*
   `scheduling.alembic_version` row instead of a table of its own (both
   services' migrations happen to number revisions `0001`-`0004` too).
   Fixed with `version_table_schema="forecasting"`.
4. **Module 01/02's own TypeORM migration-tracking table has the same class
   of bug**, one level up: no `schema` set on `DataSourceOptions`, so its
   bare-named `migrations` table resolved through `agno_migrator`'s
   search_path into `scheduling` schema (Module 04's own) rather than a
   home of its own. Lower severity than #3 (no active corruption — Module
   04's real tracking table is named `alembic_version`, a different name,
   so nothing was overwritten) but still real clutter in a schema this app
   doesn't own. Fixed by adding `schema: 'core'` to `data-source.ts`;
   *not* re-verified by re-running migrations end-to-end after the fix (see
   the readiness checklist) — the already-running, already-migrated app
   instance this session's tests connected to didn't need a re-run to keep
   working.
5. **`core.policies`' own `policies_type_check` CHECK constraint was never
   actually widened** to include the four employment `policy_type` values
   ADR-0012 describes, despite the migration file
   (`1700000001000-Module02OrgEmployeeSchema.ts`) containing the correct
   `DROP CONSTRAINT`/`ADD CONSTRAINT` statements. The migration-tracking
   table's own corruption (point 4) is the most likely explanation — a
   prior partial run appears to have recorded migrations `0001`-`0009` as
   already-applied without their DDL having actually run, so `npm run
   migration:run` in this session skipped straight from `InitialSchema` to
   `Module01Phase6WebhookSchema`. Worked around directly (the exact
   `ALTER TABLE` the migration itself contains, applied by hand) rather
   than re-baselining Module 01/02's entire migration history, which is
   that module's own team's call, not a Phase 6 scope item. Flagged in the
   readiness checklist as a real, unresolved integrity question for
   whoever owns that migration history.

## Blast radius

- `forecasting-service` gains its first gRPC dependency (`grpcio`), its
  first gRPC surface, and a `main.py`/`config.py` change (additive - the
  existing FastAPI app and all its routes are unchanged).
- `scheduling-service` gains `grpcio`/`protobuf` (see the explicit
  `protobuf` version-override assumption below) as dependencies, a new
  `app/grpc_clients/` package, and `app/services/explanation_service.py`.
- `ScheduleJobRequest.roster`/`.policy`, `ShiftSlotInput.requiredHeadcount`
  become optional (Pydantic fields gaining defaults) - wire-compatible,
  every existing caller's request body means exactly what it meant before.
- `job_service.create_job`/`approve_relaxation`/`reoptimize_schedule` all
  gained a required `js: JetStreamContext` parameter - internal signature
  change, no external contract change (every call site already had a
  `JetStreamContext` available via `app.state.jetstream`).
- Two new endpoints (`POST .../explanation`, folded into existing `GET
  .../{jobId}`), two new error codes (`UPSTREAM_DATA_UNAVAILABLE`,
  `SHIFT_HEADCOUNT_UNDETERMINED`).
- Five real bugs fixed outside this module's own codebase (see above) -
  none of them Module 04's to own long-term, all flagged in the readiness
  checklist for their respective owners.

## Explicit assumptions (spec was ambiguous, silent, or the platform's actual state disagreed with it)

1. **`protobuf>=7.35,<8.0` overrides `ortools`'s own declared
   `protobuf<6.34,>=6.33.1` constraint.** `grpc_tools.protoc`'s generated
   code embeds a minimum-runtime-version check that rejects protobuf 6.33.x
   outright at import time; a real CP-SAT solve was verified working
   correctly against protobuf 7.35.1 in this same environment (`ortools`'s
   own upper bound is conservative, not a proven runtime incompatibility) -
   the full 92-test-then-112-test suite passing throughout this phase's
   work is the ongoing proof this override is safe, not a one-time check.
2. **`core_grpc_url`/`forecasting_grpc_url` default to `localhost:5000`/
   `localhost:6000`, matching each upstream's own documented default** -
   this session's own verification ran Module 01/02's gRPC on `:5001`
   instead, purely because macOS's AirPlay Receiver squats on `:5000` by
   default on this particular machine; not a platform convention change,
   recorded here so the default itself isn't second-guessed later.
3. **Module 01/02's own migration-tracking cross-contamination (bug #4/#5
   above) was worked around, not fully re-baselined.** A real, unresolved
   question for whoever owns that module's migration history: were
   migrations `0001`-`0009`'s *other* DDL statements (skill decay, SSO,
   audit eventing, durable audit queue schemas) actually applied, or does
   this shared Postgres instance have the same "tracking says yes, DDL says
   no" gap in other tables this session's own testing didn't happen to
   touch? Not investigated further - genuinely outside Module 04's own
   scope to resolve, flagged loudly rather than silently worked around.
4. **`ReoptimizeScheduleRequest` does not get forecast-pull support this
   phase** - `policy`/`shiftSlots` (with `requiredHeadcount`) stay fully
   required there, enforced by a `model_validator`. A real future
   enhancement, not built now to keep this phase's own scope bounded.
