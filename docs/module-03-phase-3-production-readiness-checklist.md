# Module 03 Phase 3 Production Readiness Checklist

## Delivered in this phase (application code)

- [x] Real SARIMA (`statsmodels`) and Prophet training + backtesting, with
      a defined, reviewable methodology (fixed holdout, MAPE + WFA formulas
      - `app/ml/backtest.py`) satisfying §0's "no performance numbers
      without a stated methodology" rule.
- [x] Real confidence intervals (SARIMAX `get_forecast().conf_int()`,
      Prophet's native `yhat_lower`/`yhat_upper`) populated on every
      `ForecastDataPoint` this phase writes - not left `NULL`.
- [x] Ray-based parallel training dispatch (`ray_orchestrator.py`), with
      per-candidate failure isolation (one model type's fit failure becomes
      a `status: failed` `ForecastModel` row, not a crashed retrain call).
- [x] MLflow artifact logging/loading (`mlflow_registry.py`) - every
      `ForecastModel.artifact_uri` is a real, resolvable MLflow run
      artifact URI.
- [x] `POST /v1/forecasting/models/{orgUnitId}/retrain` (synchronous, ADR-
      0021 Decision 1) and `GET /v1/forecasting/models/{orgUnitId}`.
- [x] `POST /v1/forecasting/jobs` fulfills a run synchronously when an
      active model exists (ADR-0021 Decision 2), and finally calls the
      real `nats_publisher.publish_run_completed` on every completion this
      endpoint produces.
- [x] Blocking Ray/MLflow calls run via `asyncio.to_thread`, not directly
      inside `async def`s - verified by code review; not load-tested (see
      the gap below).
- [x] `app.main` and every non-training code path import and run correctly
      with **neither `ray` nor `mlflow` installed at all** (verified live) -
      proves the lazy-import design (ADR-0021 Decision 5) actually holds,
      not just asserted.
- [x] **Verified against a real Python 3.12 environment with real `ray`,
      `mlflow`, `statsmodels`, and `prophet` installed** (this project's
      actual deployment target - initially built and validated in a Python
      3.14 sandbox where none of the four would install; re-verified once
      3.12 became available). `mypy --strict` passes clean across all 54
      `app`/`tests` files with zero overrides needed for the numpy-stub
      issue that blocked full type-checking under 3.14 (ADR-0021's
      original "Decision 5" note, now stale - superseded by this line).
- [x] **A real, non-hypothetical bug was found and fixed by this
      verification**: Ray's object store deserializes returned numpy arrays
      as read-only zero-copy buffers, which crashed reconstructing a fitted
      SARIMAXResultsWrapper's internal Cython state
      (`ValueError: buffer source array is read-only`) when the live model
      object was returned through `ray.get()`. Fixed by pickling the model
      to `bytes` inside the Ray task before it ever enters the object store
      (ADR-0021, Decision 6) - confirmed by testing both ways against a
      real Ray cluster. This is exactly the class of bug static review and
      fakes cannot catch; real execution against the real target did.
- [x] 61 unit tests passing (55 original + 6 new), including real (not
      mocked) SARIMA/Prophet fit-and-forecast, a real Ray cluster training
      both model types in parallel end-to-end, a real Ray-dispatched
      failure-isolation case, and a real MLflow log/load round-trip for
      both model types (`test_ray_orchestrator_smoke.py`) - plus pure
      backtest-math tests (MAPE/WFA hand-verified against manually computed
      values).
- [x] Integration tests for the naive promotion rule, per-candidate failure
      isolation, retrain-then-list-models, and job-fulfillment-via-active-
      model use a `sys.modules`-injection fake for `ray_orchestrator`/
      `mlflow_registry` - by design, not because Ray/MLflow are
      uninstallable (they now install and run fine): keeps these DB-heavy
      tests fast/deterministic regardless.
- [x] `ruff` clean across `app/` and `tests/`.
- [x] **The full pipeline has now actually been run end-to-end**: the real
      shared dev Postgres (credentials from `.env`), a real local NATS+
      JetStream server, real Ray, real MLflow, real SARIMA/Prophet - all 79
      tests (61 unit + 18 integration) passing against live infrastructure,
      not fakes. `agno_forecasting_app`/`forecasting` schema were
      provisioned additively on the shared DB (nothing in `core`/`org`
      touched); test data was truncated afterward as courtesy cleanup on a
      shared resource.
- [x] **Three more real, non-hypothetical bugs found and fixed by this
      run** (on top of Decision 6's Ray/SARIMA one from the 3.12 upgrade
      pass):
      1. `tests/integration/conftest.py`'s `app_engine` fixture was
         session-scoped, but pytest-asyncio gives each test its own event
         loop by default - an `AsyncEngine`'s connection pool is bound to
         the loop it was created in, so reusing it across tests surfaced as
         `InterfaceError: cannot perform operation: another operation is in
         progress` starting with the second test in a file. Fixed by making
         it function-scoped.
      2. `historical_actuals_service.ingest_actuals`'s single multi-row
         `INSERT` could exceed Postgres's 32,767-bind-parameter-per-statement
         limit once enough weeks of actuals were submitted in one call (8
         params/row x ~4370 rows for a 13-week seed) - a real ingestion size
         (e.g. an onboarding backfill), not a pathological one. Fixed by
         chunking inserts at 2,000 rows/statement.
      3. Migration `0002` granted only `SELECT, INSERT` on
         `historical_actuals`, but `ingest_actuals` upserts via
         `ON CONFLICT DO UPDATE`, which Postgres requires `UPDATE`
         privilege for even on the insert path - `permission denied for
         table historical_actuals`. Fixed by granting `UPDATE` too (both in
         the migration source and applied directly to the already-migrated
         shared DB).
      Plus one test-only bug: several integration tests hardcoded literal
      forecast dates (e.g. `"2026-02-01"`) that silently fell outside the
      migration's bootstrap `(current month +/- 1)` partition window once
      enough real time had passed since the migration was applied, surfacing
      as `no partition of relation "forecast_data_points" found for row`.
      Fixed by computing dates relative to `date.today()` instead.
      None of these four were caught by `ruff`, `mypy`, or the unit suite -
      only running the real pipeline against real infrastructure found them,
      which is exactly why this line item existed.

## Explicitly NOT done here (needs a different owner or a later phase)

- [ ] **Auto-triggering training for a `queued` run with no active model.**
      A real, named gap (ADR-0021 Decision 2) - the caller must call
      `/retrain` first. No scheduled/background retraining exists either
      (§4.1's "scheduled retraining job" is not built).
- [ ] **Load/concurrency testing of `asyncio.to_thread`-dispatched
      training/inference under real concurrent request load.** The fix
      itself (moving blocking calls off the event loop) is verified by code
      review; its effect on actual concurrent-request latency under load is
      not measured.
- [ ] **A quality-gated promotion mechanism.** Phase 3's promotion is
      naive lowest-MAPE-wins (ADR-0021 Decision 3) - explicitly not what
      §0.5 requires ("not just better, but better by enough to not be
      noise"). Phase 4's stated job, not silently treated as done.
- [ ] **MLflow production backend (real tracking server + S3).** `file:`
      local backend only (ADR-0021 Decision 4) - same "not RDS/Terraform"
      posture every prior phase's Postgres dependency already carries.
- [ ] **A CI check diffing `app/db/models.py` against migration SQL.** Same
      named gap as Phase 1/2's checklists - still unaddressed.
