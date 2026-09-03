# Module 03 Phase 3 Design Doc — SARIMA + Prophet Training/Inference Pipeline

**Status:** Approved for implementation
**Owner:** Forecasting pod (Module 03)
**Scope:** Real SARIMA/Prophet training + backtesting (`app/ml/`), Ray
orchestration (`app/services/ray_orchestrator.py`), MLflow artifact tracking
(`app/services/mlflow_registry.py`), the naive Phase 3 promotion rule, and
wiring both into `POST /v1/forecasting/jobs` (fulfillment) and the new
`POST /v1/forecasting/models/{orgUnitId}/retrain` / `GET
/v1/forecasting/models/{orgUnitId}` endpoints. No LightGBM, no
quality-gated/margin-based promotion (Phase 4), no Erlang C/X (Phase 5), no
scenario simulation (Phase 6), no accuracy tracking population (Phase 7), no
TFT/GPU entitlement enforcement (Phase 8).

## Problem

Phase 1/2 built the schema and the gate/cold-start fallback; nothing
actually trained a model or produced a real forecast. Building that surfaced
one architectural question the source spec states as two separate SLOs but
doesn't wire together explicitly: how does a `queued` `ForecastRun` (Phase
1/2: nothing consumes it) actually get fulfilled without either violating
the sub-200ms submission SLO or requiring a whole new async worker/polling
subsystem this phase doesn't otherwise need? ADR-0021 answers this by
reading §0.5's two stated SLOs (submission-ack vs. a single training run) as
already describing two different, independently-scoped operations -
`/retrain` *is* the slow one, synchronously, and job submission only ever
does the fast thing (check for an existing active model, run inference if
one exists, else leave the run `queued`).

## Decision

See ADR-0021 for the five numbered decisions (synchronous retrain,
model-exists-gated job fulfillment, naive lowest-MAPE promotion, local
MLflow backend, lazy `ray`/`mlflow` imports). In addition to what that ADR
covers:

- `app/ml/backtest.py` defines the two backtest metrics as pure functions -
  MAPE (per-interval average, zero-actual points excluded) and WFA
  (volume-weighted, per ADR-0021's stated formula) - satisfying §0's "no
  performance numbers without a defined methodology" rule with actual,
  reviewable code rather than a described-but-unimplemented process.
- `app/ml/sarima.py`/`prophet_model.py` are thin, structurally identical
  wrappers (`fit_*`/`forecast_*` returning a shared `PointForecast(predicted,
  lower, upper)`), so `app/ml/training.py` and `inference_service.py` treat
  both model types uniformly rather than branching on model-specific APIs
  throughout the codebase.
- Confidence intervals are real (SARIMAX's `get_forecast().conf_int()`,
  Prophet's native `yhat_lower`/`yhat_upper`), both at the same 80% width, so
  `ForecastDataPoint.confidence_lower`/`confidence_upper` are populated with
  actual model output, not left `NULL` or faked.
- `training_service.retrain`'s blocking calls (`ray.get()`, MLflow's file
  I/O) run via `asyncio.to_thread`, not directly inside the `async def` -
  otherwise either would freeze the event loop, and every other tenant's
  concurrent request, for the full training duration. Same treatment for
  `inference_service.run_inference`'s model load + forecast call.

## Blast radius

- No schema migration this phase - `ForecastModel`/`ForecastDataPoint`
  already had every column this phase needs (Phase 1). Purely new
  application code.
- **Behavior change to `POST /v1/forecasting/jobs`**: a run that passes the
  gate now completes immediately if an active model already exists (new -
  previously always `queued`), and still queues if none exists (unchanged).
  `tests/integration/test_jobs_api.py`'s existing "sufficient history"
  test still asserts `queued` because no model has been trained for that
  org unit in that test - accurate, not stale.
- `POST /v1/forecasting/jobs` finally calls the real
  `nats_publisher.publish_run_completed` (Phase 1's skeleton) on every
  completion this endpoint produces (cold-start or model-fulfilled) - the
  Phase 1 skeleton's stated purpose, exercised for the first time.

## Rollback plan

Reverting `job_service.py`'s Decision-2 branch (fall back to always leaving
a passed-gate run `queued`, Phase 1/2's behavior) is a code-only change with
no migration to undo. `ForecastModel` rows already written are historical
records regardless - nothing needs to be deleted for a rollback to be safe.

## Explicit assumptions (spec was ambiguous or silent here)

See ADR-0021 in full; additionally:

1. **SARIMA's seasonal order is fixed at daily seasonality
   (`s=48` for 30-minute intervals)**, not the source spec's implied
   "seasonal, long clean history" full weekly cycle (`s=336`) - a stated
   compute/latency trade-off (ADR-0021's Consequences), not an accuracy
   claim. Backtest MAPE/WFA is what actually validates this per queue.
2. **Training reads at most the last 8 weeks of `historical_actuals`**
   regardless of how much history a queue has - bounds fit time against the
   2-minute SLO. A queue with a year of history doesn't get a year-long
   training set in this phase.
3. **Holdout is a fixed 2 weeks**, not a configurable fraction - keeps
   MAPE/WFA comparable across model types and across queues within a
   retrain call.
4. **A training candidate that fails to fit (e.g. SARIMAX non-convergence)
   gets a real `ForecastModel` row at `status: failed`**, not silently
   dropped - `§2.1`'s `status` enum already had `failed` as a value; Phase 3
   is the first phase to actually produce one.
5. **Multi-metric forecasting is not built.** Every `ForecastDataPoint` this
   phase writes has `predicted_volume`/confidence bounds populated and
   `predicted_aht_seconds`/`predicted_shrinkage_pct` `NULL` - continuing
   ADR-0020's `target_metric='volume'` discriminator convention rather than
   training three separate models per run. A real gap (§2.1 lists all three
   predicted columns as first-class), not silently worked around.

## Out of scope for this phase (do not build yet)

- LightGBM, the quality-gated/margin-based promotion mechanism §0.5
  requires, best-fit competition across three model types instead of two -
  Phase 4.
- Auto-triggering training when a `queued` run has no active model yet
  (ADR-0021, Decision 2's stated gap) - would need async execution decoupled
  from the submission request to respect its SLO; not built this phase.
- `Erlang C/X` → `required_headcount` - Phase 5.
- Cross-tenant cold-start matching, LightGBM feature-coverage checking -
  unchanged from Phase 2's stated boundaries.
- TFT/GPU entitlement enforcement - Phase 8, once a TFT training path exists
  to gate.
