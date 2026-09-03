# Module 03 Phase 4 Design Doc — LightGBM & Quality-Gated Promotion

**Status:** Approved for implementation
**Owner:** Forecasting pod (Module 03)
**Scope:** LightGBM as a third candidate model type (`app/ml/lightgbm_model.py`),
and the real quality-gated promotion mechanism §0.5/§4.1 require, replacing
Phase 3's naive "lowest MAPE in this batch wins" rule. No feature-ingestion
pipeline (marketing spend/campaign flags/weather), no Erlang C/X (Phase 5),
no scenario simulation (Phase 6), no accuracy tracking population (Phase 7),
no TFT/GPU entitlement (Phase 8).

## Problem

Phase 3 shipped a promotion rule explicitly flagged as a placeholder (ADR-
0021, Decision 3): among one retrain call's freshly trained candidates,
lowest backtest MAPE wins - never compared against whatever model is
already serving. §0.5 names the real requirement by name: "a retrained
model does not become `active`... unless its backtest MAPE beats the
current active model's by a defined margin... not just 'better,' but better
by enough to not be noise." Phase 4 is where §7's own phase list puts this,
paired with LightGBM as the third model type the best-fit competition
should include.

LightGBM's named use case ("feature-rich regression: marketing spend,
campaign flags, weather") assumes feature data this platform doesn't ingest
anywhere. Building that ingestion pipeline is out of proportion for a phase
whose named deliverable is the promotion mechanism, not a new data source.

## Decision

See ADR-0022 for the three numbered decisions in full (calendar-features-
only LightGBM, quantile-regression confidence intervals, and the 5%
minimum-relative-improvement promotion margin checked against the
*currently active* model, not just the freshest batch). Summary:

- `app/ml/lightgbm_model.py` trains three `Booster`s per candidate
  (`objective="quantile"`, alpha 0.1/0.5/0.9) on calendar features
  (`day_of_week`, `hour`, `minute_of_day`, `is_weekend`) derived purely from
  `interval_start` - no lag features, no external features.
- `app/ml/training.py`'s `SUPPORTED_MODEL_TYPES` and `training_service.py`'s
  `CANDIDATE_MODEL_TYPES` both gain `"lightgbm"` - it participates in the
  gate, Ray-parallel training, and MLflow logging exactly like SARIMA/
  Prophet, no special-casing needed anywhere outside `app/ml/`.
- `training_service.retrain` now looks up the currently `active`
  `ForecastModel` (if any) *before* training, and
  `decide_promotion_winner` (a pure, unit-tested function) decides whether
  this batch's best candidate should replace it: yes if no active model
  exists yet, yes if it beats the active model's stored `backtest_mape` by
  ≥5% relative, no otherwise - and "no" means the active model is left
  completely untouched, not silently kept-by-omission.
- `RetrainOutcome.reason` gains a new value,
  `"did_not_meet_promotion_margin"`, distinguishing "this was the best
  candidate in the batch but wasn't good enough to unseat what's serving"
  from "this lost to a sibling candidate" (`reason: null`) - both show up as
  `status: "deprecated"`, but the caller can tell why.

## Blast radius

- No schema migration - `ForecastModel`'s columns already covered this
  (Phase 1). Purely new application code plus one new dependency
  (`lightgbm`).
- **Behavior change to `POST /v1/forecasting/models/{orgUnitId}/retrain`**:
  a retrain call that would have promoted *any* lower-MAPE candidate in
  Phase 3 now only promotes one that clears the 5% margin against whatever
  is currently active. A retrain call that trains successfully but changes
  nothing (margin not met) is a new, real, correctly-represented outcome -
  not an error, not silently treated as a promotion.
- Retrain calls take roughly 50% longer on average (three model types
  instead of two) and LightGBM itself costs ~3x its own naive single-model
  cost (three quantile `Booster`s) - still within §0.5's 2-minute SLO in
  practice for this phase's data volumes, unmeasured at scale (same stated
  gap Phase 3 already carried forward).

## Rollback plan

Reverting `training_service.py`'s promotion logic to Phase 3's naive rule,
or removing `"lightgbm"` from `CANDIDATE_MODEL_TYPES`, are both code-only
changes with no migration to undo. Existing `lightgbm`-typed `ForecastModel`
rows remain valid historical records either way.

## Explicit assumptions (spec was ambiguous or silent here)

See ADR-0022 in full; additionally:

1. **The 5% margin is a stated default, not derived from significance
   testing.** A real paired comparison (e.g. Diebold-Mariano) would need
   both models' errors on the *same* holdout window, which today's
   per-retrain-call holdout split doesn't guarantee across calls made at
   different times. Flagged as a real limitation, not silently presented as
   rigorous.
2. **LightGBM's confidence intervals use the same 80% width convention
   (alpha 0.1/0.9) as SARIMA/Prophet**, for comparability across model
   types on the same `ForecastDataPoint` columns - not because 80% is
   independently validated as the right width for LightGBM specifically.
3. **Quantile crossing is clipped, not refit.** `lower`/`upper` are forced
   to bracket `predicted` post-hoc rather than using a monotonicity-
   constrained quantile method - simpler, and sufficient for this phase's
   "confidence interval exists and is internally consistent" bar.

## Out of scope for this phase (do not build yet)

- Lag features, external features (marketing spend/campaign flags/weather)
  for LightGBM - no ingestion pipeline exists; `insufficient_feature_coverage`
  still never fires (ADR-0022, Decision 1's consequence).
- Statistical-significance-based promotion (a true paired test) - the 5%
  relative-improvement margin is this phase's answer, revisit with Phase 7
  accuracy data.
- Auto-triggering retraining on a schedule (§4.1's "scheduled retraining
  job") - still not built, same gap Phase 3 already carried.
- Erlang C/X, scenario simulation, accuracy tracking population, TFT/GPU -
  unchanged from prior phases' stated boundaries.
