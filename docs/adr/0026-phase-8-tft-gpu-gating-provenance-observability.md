# ADR-0026: Phase 8 — TFT tier (GPU-gated), explainability/provenance API, observability + hardening

## Context

§7 names Phase 8 as "TFT tier (GPU-gated), explainability/provenance API,
observability/hardening" - the final phase, and the broadest in scope of
any of the eight. Every prior phase's design doc/checklist named pieces of
this as a stated, deferred gap: GPU/TFT entitlement enforcement (Phase 1
onward), `ForecastAccuracyLog`/`SpecialEvent` existing but §3.2's
`forecastModelProvenance` query never getting a home in this repo (Phase
1's design doc explicitly pushed the *GraphQL* version of that field to
Node/Module 01, not this service), and no structured logging, `/metrics`,
real dependency health checks, or CI wiring for this service at all across
Phases 1-7. This ADR makes six scoping decisions to turn that into working
code without trying to build everything every prior phase's "not yet"
list ever mentioned.

## Decision 1: TFT via `pytorch-forecasting`, CPU-capable, explicitly opt-in per retrain call

`app/ml/tft.py` implements `fit_tft`/`forecast_tft` using `pytorch-forecasting`'s
`TemporalFusionTransformer`/`TimeSeriesDataSet`, lazily imported (never at
module top level - same ADR-0021 Decision 5 convention as `ray`/`mlflow`/
`prophet`), calendar-features-only (`hour`, `day_of_week` as
`time_varying_known_categoricals`, matching Phase 4's LightGBM
"calendar-features-only, no lag/external features" scope decision for
consistency across model types).

**`tft` is not added to `CANDIDATE_MODEL_TYPES`** (the three model types
every `/retrain` call attempts today). `RetrainRequest` gains an optional
`modelTypes` field; omitting it keeps today's exact behavior (sarima/
prophet/lightgbm, unconditionally). Requesting `tft` is always explicit.
Two reasons: GPU/compute cost (§0.5's own "state the cost model
explicitly" ask, flagged as a Phase 8 gap in every prior checklist - an
entitled tenant training `tft` on every routine retrain call, for every org
unit, with no opt-in would make that cost implicit again, exactly the
thing being fixed) and a real architectural difference from the other
three model types (Decision 2, below) that makes "just always try it"
actively worse, not merely more expensive.

**Verified for real in this sandbox, not just structurally reviewed** -
unlike Ray/MLflow's original Phase 3 constraint (no Python 3.14 wheels),
`torch` (CPU wheel) and `pytorch-forecasting` both install and run cleanly
under this project's Python 3.12 target here. A full fit→forecast→pickle→
unpickle→forecast-again cycle was run against real synthetic data before
writing `app/ml/tft.py`, surfacing a real, non-hypothetical bug fixed by
Decision 3 below - the same "test the real dependency, don't assume"
posture ADR-0021's Decision 6 (the Ray zero-copy buffer bug) established.

## Decision 2: `forecast_tft` chunks/rolls forward past its trained horizon; SARIMA/Prophet/LightGBM don't need to

`pytorch-forecasting`'s `TimeSeriesDataSet` fixes `max_prediction_length`
at *training* time - unlike SARIMA's `.forecast(steps)`, Prophet's
`.predict(future)`, or LightGBM's calendar-feature `.predict()`, none of
which care how far past the training window `steps`/`future_index`
reaches, a single fitted TFT can only natively predict up to the horizon
it was configured for.

`fit_tft(train, holdout_periods)` reuses the *same* `holdout_periods`
already threaded through every `train_and_backtest(model_type, series,
holdout_periods)` call (no new parameter) as both the backtest window
*and* the model's trained prediction ceiling. `forecast_tft(fitted, steps)`
keeps the exact same call signature as `forecast_sarima`/`forecast_prophet`/
`forecast_lightgbm` by chunking any `steps > holdout_periods` into
`holdout_periods`-sized windows, rolling forward: each chunk after the
first feeds the *previous* chunk's own median (0.5-quantile) predictions
back in as encoder context, a standard technique for fixed-horizon
sequence models forecasting past their trained window.

**This is a real, stated accuracy tradeoff, not hidden**: chunks beyond
the first are conditioned on the model's own prior guesses, not ground
truth, so uncertainty compounds the further out a request reaches - unlike
the other three model types, whose accuracy at long horizons is only
bounded by the model itself, not by an additional autoregressive-rollout
error source. A caller requesting a `tft` forecast far beyond
`holdout_periods` gets a real answer, not an error, but a measurably rougher
one the further out it goes.

## Decision 3: `FittedTft` (state_dict + dataset spec), not the live model, is what gets pickled

A trained `TemporalFusionTransformer` **cannot be pickled directly** -
`pickle.dumps()` on the live fitted object fails with `AttributeError:
Can't get local object 'TupleOutputMixIn.to_network_output.<locals>.Output'`,
a real failure found by actually trying it against a real fitted model in
this sandbox, not predicted from documentation. Its cached forward-pass
output holds a local closure class `pickle` can't resolve.

The fix is the standard, actually-recommended way to persist PyTorch
models (not a workaround specific to this bug): persist `model.state_dict()`
(plain tensors, always picklable) plus the `TimeSeriesDataSet` spec used to
train it (confirmed independently picklable) and a short tail of the
training series (for encoder context at inference time). `FittedTft`, a
plain dataclass bundling exactly these fields, is what `train_and_backtest`
pickles into `TrainingResult.fitted_model` - unchanged from every other
model type's `pickle.dumps(fitted)` call (ADR-0021 Decision 6's
pickle-before-crossing-Ray's-object-store rule applies identically here,
now doubly load-bearing: it was originally about a *read-only-buffer*
problem, and here it's *also* the only way to serialize a TFT at all).
`forecast_tft` rebuilds a fresh `TemporalFusionTransformer` from the
dataset spec and calls `load_state_dict` before every prediction - a few
hundred milliseconds of overhead per call, accepted as the cost of a
representation that's actually picklable.

## Decision 4: GPU dispatch is a Ray resource request, gated by a settings knob defaulting to 0

`ray_orchestrator._train_and_backtest_task` is dispatched via
`.options(num_gpus=settings.tft_num_gpus if model_type == "tft" else 0).remote(...)` -
a per-call Ray resource override, not a change to the `@ray.remote`
decorator itself. `TFT_NUM_GPUS` (new `Settings` field, default `0`)
lets a real GPU-node deployment opt in without any code change; this
sandbox has no GPU (`torch.cuda.is_available()` is `False` here, confirmed
directly), so the default keeps every `tft` candidate CPU-scheduled -
correctly matching what Decision 1 already verified for real. Setting
`TFT_NUM_GPUS>0` without Ray actually seeing GPU resources on the node
would make the task queue forever waiting for a resource that never
appears - a real, stated, **not tested against actual GPU hardware** gap,
the same honest posture ADR-0021 used for Ray/MLflow before Python 3.12
was available to test against.

## Decision 5: `tft` entitlement is a hard 403 when explicitly requested, checked before the data-quality gate

ADR-0019 already states the `tft` entitlement bar is "checked before a
`tft` training job is queued at all, not just as a data-sufficiency
question." `training_service.retrain` now checks `TenantSettings.tft_entitled`
**eagerly**, before running `data_quality_service.evaluate_gate` at all,
whenever `tft` is explicitly present in the requested `modelTypes` - and
raises the already-scaffolded (since Phase 1, never previously thrown)
`TftEntitlementMissingError` (403) rather than folding it into the
per-candidate `RetrainOutcome` list every other gate failure uses. This is
a deliberate split: requesting a tier you're not entitled to is a hard
permission failure (surfaced immediately, at the top of the response, not
buried in a 200 with a `trained: false` row), while *data being
insufficient* for an entitled tenant is still the existing soft
per-candidate outcome (`reason: "insufficient_history"` /
`"excessive_gaps"`), unchanged. `evaluate_gate`'s own
`missing_tft_entitlement` check (ADR-0019) stays in place as defense in
depth, not removed - just no longer the primary way this surfaces.

**`tenant_settings` gets a real write path for the first time.** Phase 2
(ADR-0020, Gap 2) deliberately left `agno_forecasting_app` with
`SELECT`-only access, seeded only by an operator/migrator - a stated gap
("no admin API... a real admin surface is future integration work") this
phase closes: migration 0004 grants `INSERT, UPDATE`, and
`PUT /v1/forecasting/admin/tenant-settings` (gated by
`TenantContext.is_platform_admin`, the same header-driven flag every prior
phase's RLS/session setup already threads through but nothing had used
for an authorization decision yet) upserts a tenant's `tft_entitled`/
`cold_start_cross_tenant_matching_enabled` flags. Still not reconciled with
a real billing/entitlement source of truth (Module 01's `core.policies` or
equivalent) - a stated, continuing gap, not solved here.

## Decision 6: provenance is a REST audit trail over already-retained `ForecastModel` history, not a new table

§3.2's `forecastModelProvenance` was explicitly named in Phase 1's design
doc as Node/Module 01's *GraphQL* surface, not built in this repo. Phase 8
builds the REST equivalent this service can actually own:
`GET /v1/forecasting/models/{orgUnitId}/provenance` returns every
`ForecastModel` ever trained for that org unit (active, deprecated,
*and* failed rows - ADR-0021 Decision 3 already keeps deprecated models
around "for comparison/audit," a decision that had nothing reading it back
until now), ordered newest-first, plus - for the currently `active` model,
**only when it's `lightgbm`** - real feature importances read off its
persisted `Booster` (`booster.feature_importance()`/`feature_name()`, no
fabricated numbers). SARIMA/Prophet/TFT do not get comparable importances
this phase - a real, named, asymmetric gap (the same posture Phase 7 took
for Prophet-only holiday wiring): SARIMA's coefficients and Prophet's
trend/seasonality decomposition are both real, obtainable signals, just
not extracted this phase, and TFT's variable-selection-network weights
(pytorch-forecasting's actual native explainability output) require a full
`interpret_output` pass this phase doesn't build. No new `AuditLog` table -
Module 01's `core.audit_log` is schema-isolated from `forecasting`
(ADR-0017) and building a parallel one for a single read-only endpoint over
data that's already retained would be duplication with no isolation
benefit.

## Decision 7: `/healthz` + `/readyz` (mirroring Module 01's split), `/metrics` via `prometheus-client`, structured JSON logging

Module 01 already established (and this service now mirrors) a
liveness/readiness split: `/healthz` is a static 200 (this service is
running at all); `/readyz` runs `SELECT 1` against Postgres (failure →
503, matching Module 01's "a blocking dependency flips availability") and
checks the NATS connection's `is_connected` state (failure is reported in
the body but does **not** flip the status code - matching Module 01's own
"Redis down degrades latency, not availability" reasoning, applied here to
NATS since a publish failure doesn't block a job's own DB-persisted
completion). The old bare `/health` is removed - nothing in this codebase
or its tests depended on that exact path beyond a smoke check.

`/metrics` uses `prometheus-client` (the Python equivalent of Module 01's
`prom-client`), tracking `http_request_duration_seconds`/
`http_requests_total` labeled by `method`/`route`/`status_code` -
`route` is the matched route *template* (`/v1/forecasting/jobs/{job_id}`),
never the raw path, mirroring Module 01's explicit bounded-cardinality
requirement (`http-metrics.interceptor.ts`). `observability/prometheus.yml`
gets a second `scrape_configs` job block pointing at this service's own
`/metrics`, following the existing single-service file's own pattern
exactly. `envoy/envoy.yaml` is **not** touched this phase - routing this
service through the shared edge gateway is a deployment-topology decision
this phase doesn't need to make to satisfy "observability," and the file's
own header already calls it "local-dev/reference config, not production."

Structured JSON logging (`app/core/logging_config.py`) is new - Module
01/02 have no structured-logging precedent to match (plain `Logger` text,
confirmed by inspection), so this is a first cut for the platform, not a
divergence from an established convention. One JSON line per request
(`timestamp`, `level`, `method`, `path`, `status_code`, `duration_ms`,
`request_id`, `tenant_id`) is emitted from inside
`TenantContextMiddleware.dispatch`, deliberately *not* a separate
middleware layer - logging from inside the same function that calls
`bind(context)` sidesteps a real ordering hazard: an outer middleware
logging *after* `call_next()` returns would see the tenant context already
unbound (Starlette's context managers exit before control returns to an
outer layer), a bug worth avoiding by placement rather than by fighting
Starlette's middleware nesting order.

## Consequences

- New dependencies: `torch` (CPU wheel), `pytorch-forecasting`,
  `lightning`, `prometheus-client`. `torch`/`pytorch-forecasting`/
  `lightning` join the existing lazy-import convention; `prometheus-client`
  is small and imported at module top level like `fastapi`/`pydantic`
  itself (no reason to defer it - it has no heavy native deps and
  `/metrics` needs it reachable at startup, not on first use).
- Migration 0004: `GRANT INSERT, UPDATE ON forecasting.tenant_settings` -
  the only new migration this phase (no new tables; `ForecastModel`/
  `TenantSettings`/`DataQualityCheck` all existed since Phase 1/2, this
  phase only widens an existing grant).
- `training_service.retrain`'s signature gains an optional `model_types`
  parameter; every existing caller (jobs/models API, both test suites)
  continues to work unchanged by omitting it.
- `ray_orchestrator.train_candidates_in_parallel`'s candidate tuples are
  unchanged in shape (`(model_type, series, holdout_periods, holidays)`) -
  the GPU resource decision is made from `model_type` alone inside the
  orchestrator, not threaded through as a fifth tuple element.
- New, real gaps this phase does **not** close (stated, not hidden):
  a scheduler that reconciles `TFT_NUM_GPUS` against real cluster capacity;
  TFT's own native variable-selection-network explainability output;
  SARIMA/Prophet explainability; reconciling `tenant_settings.tft_entitled`
  with a real billing system; Envoy/gateway wiring; rate limiting (still
  entirely unbuilt anywhere on this platform, per every prior phase's
  checklist); a CI schema-drift check (still open, every phase's checklist
  has carried this forward since Phase 1).
