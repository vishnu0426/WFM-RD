# Module 03 Phase 7 Production Readiness Checklist

## Delivered in this phase (application code)

- [x] `POST /v1/forecasting/actuals` auto-logs `ForecastAccuracyLog` rows for
      every newly-ingested interval that has a matching prediction from a
      `completed` `ForecastRun` - idempotent per `(forecast_run_id,
      interval)`, response now reports `accuracyLogged: int`.
- [x] `GET /v1/forecasting/models/{orgUnitId}/staleness` - age-stale (>48h)
      and accuracy-degraded (recent mean MAPE >50% relative over the active
      model's own `backtest_mape`, once ≥10 samples exist) as two
      independently reported signals plus a combined `retrainRecommended` -
      read-only, never triggers a retrain itself.
- [x] `GET /v1/forecasting/accuracy/{orgUnitId}` - the accuracy trend as a
      genuine time series (`evaluated_at` = the scored interval, ascending).
- [x] `POST`/`GET /v1/forecasting/special-events` - tenant- or
      org-unit-scoped calendar tagging, RLS-isolated, tenant-wide events
      (`orgUnitId: null`) visible from any org unit's listing.
- [x] `training_service.retrain` feeds `event_type='holiday'` `SpecialEvent`
      rows into Prophet's native `holidays` mechanism for the `prophet`
      candidate only - SARIMA/LightGBM candidates unaffected.
- [x] `ray_orchestrator`'s candidate tuple shape updated
      (`+holidays: DataFrame | None`) across the real orchestrator, the
      fake-backend test fixture, and the real-Ray smoke tests - one uniform
      shape rather than a model-type-conditional call signature.
- [x] 10 new unit tests (`interval_mape`/`interval_bias` pure math - zero
      cases included; `build_holidays_frame`'s window computation; a real
      Prophet fit with a holidays frame), 116 total unit tests passing.
- [x] 13 new integration tests (accuracy auto-logging + idempotency + no-op
      on non-matching intervals + RLS isolation on the trend endpoint;
      staleness's three states - no active model, insufficient accuracy
      data, age/accuracy degraded - plus a non-mutation check; special-event
      create/list, tenant-wide visibility, RLS isolation, invalid
      `eventType` rejection) - **verified against the same real Postgres +
      NATS infrastructure Phases 3-6 used**. One real bug caught in this
      pass (not a test-authoring artifact): the initial staleness tests
      didn't seed `historical_actuals` before calling `retrain`, so the
      data-quality gate silently produced zero active models - fixed by
      reusing the same 13-week seed helper `test_training_service.py`
      established. A second real finding: `forecast_accuracy_log` has a
      live FK to `forecast_runs` (`fk_forecast_accuracy_log_tenant_run`)
      that a fabricated random `forecast_run_id` in a test violates -
      fixed by seeding a real minimal `ForecastRun` row, and worth noting
      for anyone hand-inserting `ForecastAccuracyLog` rows outside the
      ingestion-triggered path this phase builds. 157 tests total (116 unit
      + 41 integration).
- [x] `ruff`/`mypy --strict` clean across `app/` and `tests/` (76 files).

## Explicitly NOT done here (needs a different owner or a later phase)

- [ ] **No scheduler calls `/staleness` and then `/retrain` automatically.**
      Both are real, usable building blocks; closing the loop is still out
      of scope, per every prior phase's readiness checklist.
- [ ] **SARIMA/LightGBM do not consume `SpecialEvent` data.** SARIMAX
      supports exogenous regressors and LightGBM could gain an
      `is_special_event` calendar feature, but both need more (consistent
      training+inference wiring for SARIMA; inference-time event data for
      LightGBM, since nothing is baked into a fitted `Booster` the way
      Prophet bakes in `holidays`) than this phase does.
- [ ] **`expected_volume_multiplier` is stored but influences nothing.** A
      future phase would need to decide whether it's a training-time
      adjustment, an exogenous signal, or purely informational.
- [ ] **No edit/delete on `SpecialEvent`** - create/list only.
- [ ] **`GET /v1/forecasting/special-events` has no date-range filter** -
      returns everything applicable to the org unit; a caller filters
      client-side.
- [ ] **A CI check diffing `app/db/models.py` against migration SQL.** Same
      named gap carried forward from every prior phase's checklist.
