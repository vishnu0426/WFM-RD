# Module 03 Phase 4 Production Readiness Checklist

## Delivered in this phase (application code)

- [x] Real LightGBM training + backtesting on calendar features, with real
      quantile-regression confidence intervals (three `Booster`s per
      candidate) - verified against real `lightgbm` (installs and runs
      cleanly on the Python 3.11/3.12 deployment target).
- [x] The actual quality-gated promotion mechanism §0.5 requires:
      `decide_promotion_winner` (pure function, unit-tested) compares a
      fresh batch's best candidate against the *currently active* model's
      stored `backtest_mape`, requiring a 5% relative improvement to
      promote - not Phase 3's "best of this batch always wins."
- [x] `RetrainOutcome.reason: "did_not_meet_promotion_margin"` makes a
      trained-but-not-promoted outcome visible and distinguishable from
      "lost to a sibling candidate" in the API response.
- [x] All three model types (SARIMA/Prophet/LightGBM) verified through a
      real Ray cluster (parallel dispatch, no cross-contamination) and a
      real MLflow log/load round-trip - `tests/unit/test_ray_orchestrator_smoke.py`.
- [x] **The full pipeline was re-verified end-to-end against real
      infrastructure** (same shared dev Postgres + local NATS+JetStream +
      real Ray/MLflow this phase built on from Phase 3's verification pass)
      - all 95 tests (76 unit + 19 integration) passing, including the new
      margin-gated-promotion and non-promotion integration tests. No new
      infrastructure-level bugs surfaced this pass (built cleanly on Phase
      3's already-fixed foundation: the event-loop fixture scope, the
      32,767-bind-parameter chunking, and the `historical_actuals` UPDATE
      grant all still hold).
- [x] `ruff`/`mypy --strict` clean across `app/` and `tests/` (56 files) on
      the real Python 3.12 deployment target.

## Explicitly NOT done here (needs a different owner or a later phase)

- [ ] **A true statistical-significance promotion test.** The 5% relative-
      improvement margin (ADR-0022, Decision 3) is a stated default, not a
      paired significance test - would need same-holdout-window comparison
      infrastructure this platform doesn't have yet.
- [ ] **LightGBM lag features / external features.** Calendar-only
      (ADR-0022, Decision 1) - no ingestion pipeline exists for marketing
      spend/campaign flags/weather, and none is built this phase.
      `insufficient_feature_coverage` remains a reserved-but-unused
      `DataQualityCheck` enum value.
- [ ] **Auto-triggering / scheduled retraining.** §4.1's "scheduled
      retraining job" still doesn't exist - `/retrain` remains
      caller-triggered only, same gap Phase 3 already carried forward.
- [ ] **Load testing of three-model-type retrain calls at real data
      volume.** §0.5's 2-minute SLO is unmeasured at scale for this phase's
      added LightGBM cost, same stated gap as Phase 3's own SARIMA/Prophet
      cost.
- [ ] **A CI check diffing `app/db/models.py` against migration SQL.** Same
      named gap carried forward from every prior phase's checklist.
