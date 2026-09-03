# Module 03 Phase 7 Design Doc — Accuracy Tracking + Retraining Triggers

**Status:** Approved for implementation
**Owner:** Forecasting pod (Module 03)
**Scope:** `ForecastAccuracyLog` auto-population, `GET /v1/forecasting/models/{orgUnitId}/staleness`,
`GET /v1/forecasting/accuracy/{orgUnitId}`, `SpecialEvent` tagging endpoints
and Prophet-only holiday wiring. No scheduler, no automatic retraining, no
TFT/GPU (Phase 8).

## Problem

§7 names Phase 7 as "`ForecastAccuracyLog`, `SpecialEvent` tagging feeding
labeled examples back into retraining." Three real gaps stood between that
sentence and working code: nothing computes `ForecastAccuracyLog` rows from
anywhere (no cron exists in this service, by design - every prior phase's
readiness checklist named "no scheduler infrastructure" as a stated,
unclosed gap), §0.5's "stale forecast" definition is stated only as an
example ("no successful run in > 48h") not a chosen threshold, and
`SpecialEvent` had no defined mechanism for actually influencing training.

## Decision

See ADR-0025 for the five numbered decisions in full. Summary:

- **Accuracy logging is triggered by actuals ingestion, not a scheduler.**
  `POST /v1/forecasting/actuals` already learns "time has passed and we now
  know what really happened" - so after upserting `historical_actuals`, it
  also scores every `completed` `ForecastRun`'s prediction at each
  newly-ingested interval that hasn't already been scored. Idempotent per
  `(forecast_run_id, interval)` - a corrected actual doesn't overwrite an
  existing `ForecastAccuracyLog` row.
- **`evaluated_at` means "the interval being scored," not "when this row was
  written."** A deliberate, stated reinterpretation of an ambiguous spec
  column (§2.1 gives it no FK to `ForecastDataPoint` and no interval
  column), needed to make `evaluated_at` double as both the idempotency key
  and a genuine time series for the accuracy-trend endpoint.
- **MAPE/bias formulas**, per interval, same zero-actual guard
  `app/ml/backtest.py` already uses: `mape = |actual-predicted|/|actual|*100`,
  `bias = (predicted-actual)/actual*100` (signed - positive means
  over-forecast).
- **"Stale" is two independent, precisely defined conditions**: age-stale
  (active model's `trained_at` > 48h old, §0.5's own literal example) and
  accuracy-degraded (mean `mape` across the most recent 10
  `ForecastAccuracyLog` rows exceeds the active model's own `backtest_mape`
  by ≥50% relative). `retrainRecommended = ageStale OR accuracyDegraded`.
  Fewer than 10 accuracy rows reports `insufficientAccuracyData: true`
  rather than a false "not degraded."
- **Staleness is a signal, not an automatic retrain.**
  `GET .../staleness` never calls `training_service.retrain` - that can take
  up to ~2 minutes (§0.5's own SLO), and silently running it inside a
  frequently-called ingestion endpoint would repeat exactly the SLO
  violation ADR-0021 Decision 2 already rejected for job submission. The
  caller reads the signal and calls the existing
  `POST /v1/forecasting/models/{orgUnitId}/retrain` itself.
- **`SpecialEvent` feeds Prophet's native `holidays` mechanism only.**
  `training_service.retrain` fetches `event_type='holiday'` rows (org-unit
  and tenant-wide) covering the training lookback window plus a 180-day
  forward margin, converts them to Prophet's `(holiday, ds, lower_window,
  upper_window)` schema, and passes them to `fit_prophet` for the `prophet`
  candidate only. SARIMA/LightGBM do not consume this signal this phase - a
  real, named, asymmetric gap (ADR-0025 Decision 5).

## Blast radius

- No migration - `SpecialEvent`/`ForecastAccuracyLog` existed since Phase 1
  with grants already in place (confirmed by inspection of migration 0001
  before starting). Purely new application code:
  `app/ml/accuracy.py`, `app/services/accuracy_service.py`,
  `app/services/special_event_service.py`, `app/api/v1/accuracy.py`,
  `app/api/v1/special_events.py`, a new `/staleness` route on the existing
  `models` router, and `build_holidays_frame`/an optional `holidays`
  parameter added to `app/ml/prophet_model.py`.
- `ray_orchestrator.train_candidates_in_parallel`'s candidate tuple grew
  from `(model_type, series, holdout_periods)` to `(model_type, series,
  holdout_periods, holidays)` - `holidays` is `None` for every non-Prophet
  candidate, carried along unused rather than branching the call signature
  by model type. Updated every existing caller (`training_service.retrain`,
  `tests/integration/conftest.py`'s `fake_ml_backends` fixture,
  `tests/unit/test_ray_orchestrator_smoke.py`).
- `POST /v1/forecasting/actuals`'s response gained an `accuracyLogged: int`
  field and now does bounded extra work (arithmetic over already-computed
  predictions at the ingested intervals, not ML) - not a hypothetical
  inline retrain, so its latency profile is essentially unchanged.

## Rollback plan

Removing the `accuracy`/`special-events` routers and the `models` router's
`/staleness` sub-route from `main.py`, and reverting the
`accuracy_service.log_accuracy_for_new_actuals` call out of
`actuals.py`, is code-only - `ForecastAccuracyLog`/`SpecialEvent` predate
this phase and nothing else depends on rows they contain. The
`ray_orchestrator` candidate-tuple shape change would need reverting
alongside, but is contained entirely within this service's own internal
training pipeline (not a public contract).

## Explicit assumptions (spec was ambiguous or silent here)

See ADR-0025 in full; additionally:

1. **The 180-day holiday forward margin is a stated default, not derived
   from any real forecast-horizon input.** `training_service.retrain` has
   no forecast-horizon parameter (that's chosen later, per job, via
   `POST /v1/forecasting/jobs`) - holidays are fetched for the training
   lookback window plus this fixed margin so a model trained today still
   carries holiday effects for typical near-term forecast requests.
2. **A `SpecialEvent`'s `expected_volume_multiplier` is stored and
   queryable but not applied anywhere in this phase** - Prophet's holiday
   mechanism learns an additive effect from the training data itself, it
   doesn't consume a pre-specified multiplier. Wiring that multiplier into
   SARIMA/LightGBM (or as a training-time volume adjustment generally) is
   deferred, per ADR-0025 Decision 5's consequences.
3. **`GET /v1/forecasting/special-events` has no date-range filter** - it
   returns every tenant-wide + org-unit-scoped event for the given org
   unit, ordered by `date_range_start`. A caller wanting "only events in
   the next 90 days" filters client-side; this phase's only date-range-aware
   query is `special_event_service.list_holidays_for_training`, used
   internally by `retrain`, not exposed as an endpoint parameter.

## Out of scope for this phase (do not build yet)

- Any scheduler/cron that calls `/staleness` and then `/retrain`
  automatically - both endpoints exist as building blocks for a future
  orchestrator (still explicitly out of scope, per every prior phase's
  readiness checklist), not a closed loop themselves.
- SARIMA/LightGBM consuming `SpecialEvent` data (exogenous regressors /
  calendar features respectively) - a real, named gap, not silently
  skipped.
- `expected_volume_multiplier` feeding into any training-time adjustment.
- Editing/deleting a `SpecialEvent` once created (`POST`/`GET` only).
