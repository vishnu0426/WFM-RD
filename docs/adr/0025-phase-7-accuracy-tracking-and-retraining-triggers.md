# ADR-0025: Phase 7 — accuracy logging triggered by actuals ingestion, a precise staleness definition, and Prophet-only SpecialEvent feeding

## Context
§7 names Phase 7 as "`ForecastAccuracyLog`, `SpecialEvent` tagging feeding
labeled examples back into retraining." Three real gaps stood between that
sentence and working code: nothing computes `ForecastAccuracyLog` rows from
anywhere (no cron exists in this service, by design - every prior phase's
readiness checklist named "no scheduler infrastructure" as a stated,
unclosed gap), §0.5's "stale forecast" definition is stated only as an
example ("no successful run in > 48h") not a chosen threshold, and
`SpecialEvent` has no defined mechanism for actually influencing training.

## Decision 1: accuracy logging is triggered by actuals ingestion, not a scheduler
`POST /v1/forecasting/actuals` is the one place this service already learns
"time has passed and we now know what really happened" - so it's also the
natural trigger for accuracy evaluation, with no new infrastructure. After
upserting `historical_actuals`, `accuracy_service.log_accuracy_for_new_actuals`
finds every `completed` `ForecastRun` for that org unit with a
`ForecastDataPoint` at one of the newly-ingested `interval_start`s that
doesn't already have a `ForecastAccuracyLog` row, and computes one -
per-interval, not aggregated per run, matching `ForecastAccuracyLog`'s own
schema (`evaluated_at` is part of its partition key, ADR-0018). A given
`ForecastDataPoint` is scored at most once - `INSERT ... ON CONFLICT DO
NOTHING`-equivalent (check-then-insert inside the same transaction) rather
than overwriting if actuals are corrected later, since `ForecastAccuracyLog`
is a historical record of "what we knew when," not a live-updating view.

**`evaluated_at` means "the interval being scored," not "when this row was
written."** §2.1's `ForecastAccuracyLog` schema has no column identifying
*which* forecasted interval a row is about, and no FK to
`ForecastDataPoint`. Setting `evaluated_at` to wall-clock "now" (the literal
reading of the column name) would make every row from one ingestion call
cluster at nearly the same timestamp, making `forecastAccuracyTrend(orgUnitId,
period)` (§3.2) meaningless as a time series and giving idempotency
("did we already score this interval") no key to check against. Instead,
`evaluated_at` is set to the `ForecastDataPoint.interval_start` being
scored - a deliberate, stated reinterpretation of an ambiguous spec column,
not a literal implementation of its name. This doubles as the idempotency
check (`WHERE forecast_run_id = X AND evaluated_at = interval_start`) and
makes accuracy genuinely queryable as a trend over the forecasted period,
not the ingestion schedule.

## Decision 2: MAPE/bias formulas, stated
Per interval: `mape = |actual - predicted| / |actual| * 100` (undefined,
row not written, when `actual == 0` - same zero-guard `app/ml/backtest.py`
already uses for training-time MAPE, for consistency). `bias =
(predicted - actual) / actual * 100` - signed: positive means this service
over-forecast that interval, negative means it under-forecast, `NULL` under
the same zero-actual guard.

## Decision 3: "stale" is two independent, precisely defined conditions
`GET /v1/forecasting/models/{orgUnitId}/staleness`:
- **Age-stale**: the active model's `trained_at` is more than **48 hours**
  old - §0.5's own literal example threshold, adopted as-is rather than
  re-derived, since the spec already committed to a specific number here.
- **Accuracy-degraded**: the mean `mape` across the most recent **10**
  `ForecastAccuracyLog` rows for the org unit exceeds the active model's own
  stored `backtest_mape` by **≥50% relative** (`recent_mape > backtest_mape
  * 1.5`) - a stated default, not a statistically derived significance
  threshold (same honest posture as ADR-0022's 5% promotion margin).
  Evaluated only once at least 10 rows exist - fewer is too noisy to act on,
  reported as `insufficient_accuracy_data` rather than silently treated as
  "not degraded."
- `retrainRecommended = ageStale OR accuracyDegraded`. This is the "trigger"
  Phase 7 names: a precise, queryable *signal*, not an automatic action -
  see Decision 4 for why.

## Decision 4: staleness is a signal, not an automatic retrain
`GET .../staleness` never calls `training_service.retrain` itself. Retrain
can take up to ~2 minutes (§0.5's own SLO); silently running one inside a
different endpoint's request - or worse, inside `POST /v1/forecasting/actuals`,
an ingestion endpoint a tenant may call frequently - would repeat exactly
the SLO violation ADR-0021's Decision 2 already rejected for job submission.
The caller (a human, or eventually a real external scheduler - still
explicitly out of scope, per every prior phase's readiness checklist) reads
the signal and calls the existing, unconditional
`POST /v1/forecasting/models/{orgUnitId}/retrain` itself. Phase 4's
quality-gated promotion (ADR-0022) is what keeps this safe even if a
degraded-but-still-adequate model gets retrained speculatively - a fresh
candidate only replaces it if it actually clears the margin.

## Decision 5: `SpecialEvent` feeds Prophet's native holiday mechanism, not SARIMA/LightGBM
Prophet accepts a `holidays` DataFrame at construction time and bakes the
effect into the fitted model - future dates falling in a tagged (even
future-dated) window are handled automatically at `.predict()` time with no
extra data needed at inference. `training_service.retrain` fetches
`event_type='holiday'` `SpecialEvent` rows (org-unit-specific and
tenant-wide, `org_unit_id IS NULL`) covering the training lookback window
*and* the forecast horizon, and passes them to `fit_prophet` when training a
`prophet` candidate. **SARIMA and LightGBM do not consume this signal in
this phase** - SARIMAX supports exogenous regressors (`exog`) but wiring
that consistently across training and every future inference call is
materially more work; LightGBM could cheaply gain an `is_special_event`
calendar feature, but doing so *correctly* needs event data threaded
through inference too (unlike Prophet, nothing is baked into a fitted
`Booster`), which this phase defers. A real, named, asymmetric gap - not
silently glossed over.

## Consequences
- No migration - `SpecialEvent`/`ForecastAccuracyLog` existed since Phase 1
  with grants already in place. Purely new application code.
- `POST /v1/forecasting/actuals`'s response time now includes accuracy
  evaluation - bounded by "how many `ForecastDataPoint`s exist at the
  ingested intervals," not by any ML work, so this stays fast (arithmetic
  over already-computed predictions), unlike a hypothetical inline retrain.
- Only `event_type='holiday'` events feed Prophet - `marketing_campaign`/
  `product_launch`/`anomaly_flagged` are stored and queryable
  (`GET /v1/forecasting/special-events`) but influence nothing in the
  training pipeline yet, a real gap for a future phase (they'd need
  `expected_volume_multiplier` applied as a training-time adjustment or
  exogenous signal, not just a Prophet-style additive holiday effect).
- `insufficient_accuracy_data` is a third staleness state (alongside
  `true`/`false`) surfaced explicitly in the response, not collapsed into
  `accuracyDegraded: false` - a caller can distinguish "we checked and it's
  fine" from "we don't have enough data to check yet."
- Since `evaluated_at` (= the scored interval) is `forecast_accuracy_log`'s
  partition key (ADR-0018), scoring a very old forecast against
  late-arriving actuals can hit "no partition of relation found" if that
  month's partition was never provisioned - the same accepted, already-
  documented fail-closed gap ADR-0005/0018 already carry for partition
  rotation, not a new one this phase introduces.
