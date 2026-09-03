# ADR-0021: Phase 3 training/inference architecture — synchronous retrain, model-exists-gated job fulfillment, naive promotion, local MLflow backend

## Context
Phase 3 builds real SARIMA/Prophet training and inference. Four questions
had to be answered that the source spec states as goals (§4, §5, §0.5) but
not as a wire-level design: how retraining is actually triggered without
violating the job-submission SLO, what happens to a `queued` `ForecastRun`
now that something *can* consume it, how a freshly trained model becomes
`active` before Phase 4's full quality-gated promotion mechanism exists, and
where MLflow artifacts physically live in this phase.

## Decision 1: `POST /v1/forecasting/models/{orgUnitId}/retrain` is synchronous
§0.5 states two *separate* SLOs: job submission → `queued` ack (p99 < 200ms)
and a single-queue SARIMA/Prophet run (p95 < 2 min). These are different
operations with different latency budgets by the spec's own design - not a
single SLO applying to every endpoint. `/retrain` is the operation the
2-minute budget describes, so it runs synchronously (statsmodels/Prophet fit
+ backtest, `ray.get()`-blocked on the Ray tasks) within the HTTP request,
returning the trained models' results directly. No queueing, no separate
worker process, no polling infrastructure - none of that is needed once
`/retrain` is understood as the (slower, on-demand-or-scheduled) operation
§0.5 already scoped it as, not as an extension of the fast job-submission path.

## Decision 2: `POST /v1/forecasting/jobs` fulfills a run only if an active model already exists
A `queued` `ForecastRun` (Phase 1/2: gate passed, nothing consumes it) is now
handled at submission time: if an `active` `ForecastModel` already exists for
`(org_unit_id, target_metric='volume')`, inference runs synchronously (model
load + `.forecast()` is fast - low seconds, not minutes) and the run is
returned `status: completed`, same synchronous-completion shape Phase 2
already established for cold-start. If no active model exists yet, the run
stays `queued` - it is **not** auto-triggered into a training run inline,
because training can take up to 2 minutes and doing that inside `POST
/v1/forecasting/jobs` would blow the 200ms submission SLO for the common
"first request for a new queue" case. The caller (or a scheduled job, out of
scope for this phase) is expected to call `/retrain` first. This is a real,
stated gap - flagged in the production readiness checklist, not hidden.

## Decision 3: Phase 3's promotion rule is naive - lowest backtest MAPE wins
§0.5 names the real mechanism explicitly: "not just better, but better by
enough to not be noise - state a statistical significance or
minimum-improvement threshold." That mechanism, plus LightGBM as a third
competing model type, is explicitly Phase 4 scope (§7's own phase list:
"Phase 4 — LightGBM + best-fit selection/promotion logic. The quality-gated
promotion mechanism from §0.5/§4.1"). Phase 3 needs *some* rule to make a
freshly trained model usable at all, so it uses the simplest defensible one:
among this retrain call's successfully trained candidates (SARIMA, Prophet -
whichever pass their own `DataQualityCheck` gate), the one with the lowest
`backtest_mape` becomes `active`; any previously `active` model for the same
`(org_unit_id, target_metric)` and every other freshly trained candidate
become `deprecated` - matching §4.1's own instruction to keep losers "for
comparison/audit," not discard them. **This is explicitly not the
quality-gated mechanism §0.5 requires** - a MAPE improvement of 0.01 flips
`active` today, with no significance/minimum-margin check. Phase 4 replaces
this function's body, not its call site.

## Decision 4: MLflow tracking is a local `file:` backend in this phase
The mandated stack is MLflow + S3 artifact storage (§1). Phase 3 runs MLflow
against `MLFLOW_TRACKING_URI` defaulting to `file:./mlruns` (a local
directory) rather than standing up a real MLflow tracking server + S3
bucket - the same "real Postgres is Terraform/RDS, `docker-compose.yml` is
local-dev-only" posture every prior phase's production readiness checklist
already established for its own infra dependency. `ForecastModel.artifact_uri`
stores whatever URI MLflow returns (a local path in dev, `s3://...` once a
real tracking server is configured in production) - application code never
hard-codes the scheme.

## Decision 5: `ray`/`mlflow` are imported lazily, inside the functions that use them
Both are heavy, optional-at-import-time dependencies. `app/services/
training_service.py` and `app/services/mlflow_registry.py` import them inside
function bodies, not at module top level, so importing `app.main` (and every
route/test that doesn't touch training) never requires a Ray cluster or an
MLflow tracking store to be reachable.

**Update**: this phase was first built in a Python 3.14 sandbox with no
`ray` wheel available at all, so Decision 5's Ray/MLflow-touching code paths
were initially verified only by static review + `sys.modules`-fake
integration tests, not a live run - a stated, tracked gap (see the
production readiness checklist's original version). Once this project's
actual Python 3.11/3.12 deployment target became available, running it for
real immediately surfaced a genuine bug (not a hypothetical one) - see
Decision 6.

## Decision 6: `TrainingResult.fitted_model` is pickled `bytes`, not a live model object
Running `ray_orchestrator.train_candidates_in_parallel` for real (Python
3.12, real Ray, real `statsmodels`/`prophet`) crashed for SARIMA
specifically: `ValueError: buffer source array is read-only`, thrown while
Ray deserialized the task's return value back in the calling process.
Root cause: Ray's object store returns numpy arrays as read-only zero-copy
buffers by design (to avoid an unnecessary copy for the common case), but
reconstructing a fitted `SARIMAXResultsWrapper`'s internal Kalman-filter
state (`statsmodels.tsa.statespace._initialization`, a Cython extension)
needs a *writable* memoryview over that buffer - Prophet's pure-Python
state has no equivalent internal requirement, so it never hit this.

**Decision**: `train_and_backtest` (`app/ml/training.py`) pickles the fitted
model to `bytes` itself, immediately after fitting, *before* returning -
so the value that actually crosses Ray's object store boundary is an opaque
byte string, never a live object containing memoryviews over shared-memory
buffers. Confirmed by testing both ways against a real Ray cluster:
returning the live object crashes on `sarima`, returning pre-pickled bytes
works for both model types. `mlflow_registry.log_model` writes these bytes
directly (no longer re-pickles); `load_model` is unchanged (unpickles from
the artifact file either way).

## Consequences
- `ForecastRun.forecast_model_id` and inference are scoped to
  `target_metric='volume'` only, continuing ADR-0020's discriminator
  convention - `predicted_aht_seconds`/`predicted_shrinkage_pct` stay `NULL`
  on every `ForecastDataPoint` this phase writes. Multi-metric forecasting
  (separate models per target_metric feeding one run) is a real gap, not
  solved by this schema's current one-model-per-run shape - flagged, not
  silently worked around.
- SARIMA's seasonal order is fixed at daily seasonality
  (`seasonal_order=(1,1,1,48)` for 30-minute intervals) as a stated default,
  not a tuned choice - weekly seasonality (`s=336`) is computationally
  rough at this data volume and deferred. Backtest MAPE/WFA is what actually
  validates or invalidates this choice per queue, not an a priori claim of
  fitness.
- Training reads at most the last `TRAINING_LOOKBACK_WEEKS` (8) of
  `historical_actuals`, bounding fit time regardless of how much history a
  queue has accumulated - a compute/latency trade-off against the 2-minute
  SLO, not an accuracy-maximizing choice.
