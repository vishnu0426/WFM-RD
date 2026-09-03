# ADR-0022: Phase 4 — LightGBM's feature scope, and the quality-gated promotion mechanism §0.5 actually requires

## Context
Phase 3 shipped a deliberately naive promotion rule (ADR-0021, Decision 3):
among one retrain call's freshly trained candidates, lowest `backtest_mape`
wins, full stop — never compared against whatever model is already
`active`. §0.5 names the real requirement explicitly: "a retrained model
does not become `active`... unless its backtest MAPE beats the current
active model's by a defined margin (e.g. not just 'better,' but better by
enough to not be noise)." Phase 4 is where that gets built, per §7's own
phase list, alongside LightGBM as the third candidate model type.

LightGBM's own row in the module prompt's model table names its use case as
"feature-rich regression (marketing spend, campaign flags, weather)" — none
of which this platform ingests anywhere (ADR-0020 already flagged
`insufficient_feature_coverage` as a reserved-but-unused `DataQualityCheck`
enum value for exactly this reason). Building a real external-feature
ingestion pipeline is out of proportion for this phase and not requested by
name in §7's phase list ("Phase 4 — LightGBM + best-fit selection/promotion
logic" — the promotion mechanism is the named deliverable, not a new
ingestion pipeline).

## Decision 1: LightGBM trains on calendar features only, derived from `interval_start` itself
Every training example is `(day_of_week, hour, minute_of_day, is_weekend) ->
actual_volume`, built purely from timestamps already in `historical_actuals`
— no lag features (yesterday's/last week's actual at the same time), no
external features. This is a real, legitimate LightGBM time-series approach
(a gradient-boosted tree learning the day/time seasonal pattern from many
historical examples, functionally analogous to what SARIMA/Prophet capture
via their own seasonal machinery, just via decision trees over calendar
features instead of a state-space or additive model) — not a stub, and not
a claim of superiority over lag-based or truly feature-rich approaches.

**Consequence**: `insufficient_feature_coverage` still never fires — there
are no external features to have insufficient coverage of. Lag-feature and
true external-feature (marketing spend, campaign flags, weather) support
are real, named gaps for a future phase once this platform actually ingests
that data, not solved here.

## Decision 2: Confidence intervals via LightGBM quantile regression
Three models are trained per candidate, not one: `objective="quantile"` at
`alpha=0.1`/`0.5`/`0.9` for lower/point/upper — matching the 80% interval
width SARIMA (`get_forecast().conf_int(alpha=0.20)`) and Prophet
(`interval_width=0.8` default) already use, so all three model types'
`ForecastDataPoint.confidence_lower`/`confidence_upper` are comparable in
what they claim to represent. All three still get pickled to `bytes` inside
the Ray task before returning (ADR-0021, Decision 6's fix applies uniformly
regardless of model type, not just SARIMA) and packaged together as one
`fitted_model` payload (a small dict of three `Booster`s) so `ForecastModel`
still has exactly one `artifact_uri` per trained candidate.

## Decision 3: quality-gated promotion — a minimum relative-improvement margin against the *stored active model*, not just the freshest batch
`training_service.retrain` now:
1. Looks up the currently `active` `ForecastModel` (if any) for
   `(org_unit_id, target_metric)` *before* deciding anything.
2. Picks the best (lowest-MAPE) candidate among this call's freshly trained,
   successful results — same as Phase 3.
3. Promotes that candidate to `active` only if **no active model exists
   yet**, or its `backtest_mape` beats the stored active model's by at least
   `MIN_RELATIVE_IMPROVEMENT` (**5%**, i.e. `new_mape <= active_mape * 0.95`)
   — otherwise every fresh candidate stays `deprecated` and the existing
   `active` model is left untouched (not silently swapped for a
   noise-level-better challenger, and not silently kept if a genuinely
   better model was just trained but the margin wasn't met — an explicit,
   visible-in-the-response non-promotion, not a promotion).

5% is a stated, reasoned default (this platform has no backtested
significance-testing infrastructure yet — a real Diebold-Mariano-style
paired test would need both models' errors on the *same* holdout window,
which today's per-retrain-call holdout split doesn't guarantee across
retrain calls run at different times), not a statistically derived number.
Revisit once Phase 7's `ForecastAccuracyLog` gives this platform real
production accuracy data to reason about margins from.

## Consequences
- `RetrainOutcome.status` gains a real, distinct meaning: `"active"` (this
  call's winner *and* it cleared the margin), `"deprecated"` (either it lost
  to another fresh candidate, or it won among fresh candidates but didn't
  beat the stored active model by enough). The response body is the only
  place a caller can see *why* nothing changed on a retrain call that
  trained successfully but promoted nothing.
- The stored active model's `backtest_mape` was computed against a
  *different* holdout window (whenever it was originally trained) than this
  retrain call's fresh candidates. Comparing MAPEs across different holdout
  windows is an accepted, stated limitation of this margin check — not a
  paired statistical test, a documented heuristic pending Phase 7 data.
- Training three quantile models instead of one roughly triples LightGBM's
  per-candidate compute cost within a retrain call — still bounded by the
  same `TRAINING_LOOKBACK_WEEKS`/holdout constants Phase 3 set, and still
  within §0.5's 2-minute single-queue SLO in practice (unverified at scale,
  same gap already flagged for Phase 3's compute cost).
