# Module 03 Phase 5 Design Doc — Erlang C Headcount Conversion

**Status:** Approved for implementation
**Owner:** Forecasting pod (Module 03)
**Scope:** Real `required_headcount` computation (`app/ml/erlang.py`), a new
`service_level_targets` table for the business-configuration Erlang C
needs, and the AHT/shrinkage fallback chains that make it actually work
against a model-fulfilled `ForecastDataPoint` (which has neither populated,
per ADR-0020/0021's discriminator convention). No Erlang X/A (abandonment),
no scheduling logic (OR-Tools - explicitly Module 04's job per §8), no
scenario simulation (Phase 6), no accuracy tracking population (Phase 7),
no TFT/GPU (Phase 8).

## Problem

§7 names Phase 5 as "Erlang C/X headcount conversion... feeding off
`predicted_volume`/`predicted_aht_seconds`/`predicted_shrinkage_pct`" as if
those three inputs are already sitting there ready to convert. They aren't:
Erlang C itself needs a target service level and answer-time threshold this
schema never defined, and two of the three named inputs
(`predicted_aht_seconds`, `predicted_shrinkage_pct`) are `NULL` on every
model-fulfilled `ForecastDataPoint` this service has ever written (only
cold-start-seeded points have them, via donor averaging). Building real
Erlang C meant resolving both gaps, not just writing the formula.

## Decision

See ADR-0023 for the four numbered decisions in full (Erlang C only,
numerically-stable Erlang-B-based implementation, the new
`service_level_targets` table with platform defaults, and the AHT/shrinkage
fallback chains). Summary:

- `app/ml/erlang.py` - pure, dependency-free (just `math`) Erlang C:
  `erlang_c_probability`/`service_level`/`required_agents`/
  `required_headcount`, cross-checked against an independent log-space
  reference implementation of the textbook formula (not just internal
  self-consistency).
- `forecasting.service_level_targets` (migration `0003`) - tenant-writable,
  platform defaults (80% service level / 20s / 85% max occupancy) apply
  when unconfigured, so headcount computation works without requiring setup
  first.
- `app/services/headcount_service.py` - `build_headcount_context` resolves
  the service level target + historical AHT/shrinkage averages *once* per
  forecast run (not once per interval - avoids an N+1 query pattern), and
  `compute_required_headcount` is a pure per-interval function using that
  context plus whatever the interval's own `predicted_aht_seconds`/
  `predicted_shrinkage_pct` already carry.
- Wired into both `inference_service.run_inference` (model-fulfilled path,
  relies entirely on the historical fallback since the model itself never
  forecasts AHT/shrinkage) and `cold_start_service.seed_cold_start_forecast`
  (donor-averaged AHT/shrinkage win over the fallback when present).
- `PUT`/`GET /v1/forecasting/service-level-targets/{orgUnitId}`.

## Blast radius

- Additive migration (`0003`) - one new table, no change to any existing
  table's shape.
- **Behavior change**: every `ForecastDataPoint` this service writes from
  now on has a real, non-`NULL` `required_headcount` whenever volume and
  *some* AHT estimate (own or historical) are available - closing the one
  column every prior phase always left empty. A queue with volume history
  but zero AHT history anywhere still gets `NULL` (a real, explained gap,
  not silently guessed at).
- `inference_service`/`cold_start_service` each gain one extra DB round
  trip per run (`build_headcount_context`), not per interval.

## Rollback plan

Reverting the two call sites to stop calling `compute_required_headcount`
(leaving `required_headcount=None` again, Phase 1-4's behavior) is
code-only. `DROP TABLE forecasting.service_level_targets` has no dependents
elsewhere in this schema.

## Explicit assumptions (spec was ambiguous or silent here)

See ADR-0023 in full; additionally:

1. **`required_headcount` is fractional, not rounded to an integer.** The
   Erlang C agent search itself is integer (agents must be whole people),
   but dividing by `(1 - shrinkage)` produces a fraction, stored as-is -
   Module 04 (Scheduling) decides rounding, not this service.
2. **The AHT/shrinkage historical lookback window is 8 weeks**, matching
   `training_service`'s own `TRAINING_LOOKBACK_WEEKS` constant, for
   consistency (not because 8 weeks is independently validated as the right
   window for either purpose).
3. **No endpoint lists `ForecastDataPoint` rows.** `required_headcount` is
   verified in this phase's integration tests via a direct DB query (same
   pattern `test_rls_isolation.py` already uses), not through a REST
   response - §3.2's GraphQL `ForecastRun.dataPoints` field is Node's
   surface to build, fed by this service's data, not duplicated here.

## Out of scope for this phase (do not build yet)

- Erlang X/A (abandonment-aware) - no patience/abandon data exists anywhere
  in this platform to parameterize it with (ADR-0023, Decision 1).
- An admin/self-service reconciliation between `service_level_targets` and
  whatever a real contact-center platform's own SLA config might already
  hold - local to this schema, same posture as `queue_profiles`/
  `tenant_settings`.
- Scheduling logic (OR-Tools solver) - explicit non-goal, §8: "Module 03
  only supplies `required_headcount`... consumed by Module 04."
- Multi-metric forecasting (a real model actually predicting AHT/shrinkage,
  not just falling back to a historical average) - still the same named gap
  ADR-0020/0021 already carried forward.
