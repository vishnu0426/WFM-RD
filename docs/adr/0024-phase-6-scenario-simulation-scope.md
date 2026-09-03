# ADR-0024: Phase 6 — scenario simulation is arithmetic over an existing run, not a re-forecast

## Context
§7 names Phase 6 as "`ScenarioSimulation` producing a real `ForecastRun`,
same read path as live forecasts." §2.1's `ScenarioSimulation` entity
already exists (Phase 1 schema) with `assumption_overrides` (jsonb, "e.g.
volume_multiplier, aht_delta") and `result_forecast_run_id` - nothing
scoped what actually computes that result run, or what a caller can assume
about it once the endpoint exists.

## Decision 1: scenarios adjust an existing base run's data, they don't retrain
A scenario answers "what would `required_headcount` look like if volume
were 20% higher" - it does not need statsmodels/Prophet/LightGBM re-fit
against hypothetical data, and re-forecasting would conflate "a different
model's opinion" with "the same forecast, adjusted." `scenario_service.
create_scenario` takes an existing `base_forecast_run_id`'s
`ForecastDataPoint` rows and applies `assumption_overrides` arithmetically:
`volume_multiplier` (multiplicative, default 1.0, `>= 0`), `aht_delta_seconds`
(additive, default 0), `shrinkage_delta_pct` (additive, default 0, clamped
to `[0, 0.99]`). This is why it completes synchronously in the same request
(no Ray, no MLflow, no 2-minute SLO to budget for) - `status: completed` by
the time `POST /v1/forecasting/scenarios` returns, matching cold-start's
existing synchronous-completion precedent (ADR-0020) rather than Phase 3's
training-bound async pattern.

## Decision 2: the scenario's `ForecastDataPoint` rows store *resolved*, not raw, AHT/shrinkage
A base run's `predicted_aht_seconds`/`predicted_shrinkage_pct` are often
`NULL` (model-fulfilled runs, ADR-0020/0021's convention) - Phase 5's
`required_headcount` on that base run already came from the historical
fallback chain (`headcount_service`), not from those `NULL` columns
directly. A scenario's whole value is showing *what was assumed* - so
`create_scenario` resolves each point's effective AHT/shrinkage (own value,
or the same fallback Phase 5 would have used) *before* applying the
override delta, and stores that resolved-and-adjusted number on the new
`ForecastDataPoint`, not `NULL`. This is a deliberate, stated departure
from the base run's own convention, not an inconsistency: a scenario is
inherently a hypothetical construct, and hiding the assumption behind
`NULL` would defeat the point of building one.

## Decision 3: confidence bounds scale with `volume_multiplier`
`confidence_lower`/`confidence_upper` on the new points are the base run's
own bounds scaled by `volume_multiplier` (preserving the original relative
band width) - a stated heuristic, not a re-derived statistical interval
for the hypothetical scenario. Phase 3/4's actual confidence intervals came
from each model's own machinery (SARIMAX `conf_int`, Prophet's
`yhat_lower`/`upper`, LightGBM quantile regression); a scenario has no
underlying model fit to ask for a real interval, so scaling the existing
one is the honest, cheap answer, not a claim of statistical rigor.

## Decision 4: the result run publishes the same completion event a live forecast does
`agno.forecasting.run.completed.v1` (§3.4) fires for the scenario's
`result_forecast_run_id` exactly as it does for `job_service.create_job`'s
completions - "same read path as live forecasts" (§7's own words) extends
to the event contract, not just the polling endpoint. A subscriber has no
way to distinguish "a real forecast completed" from "a scenario completed"
from the event alone today (both just carry `forecastRunId`/`orgUnitId`/
`status`) - a caller that cares needs to separately track which
`forecastRunId`s came from `POST /v1/forecasting/scenarios` vs
`POST /v1/forecasting/jobs`, e.g. via `GET /v1/forecasting/scenarios/{id}`.

## Consequences
- `ScenarioSimulation.status` reaches `completed`/`failed` synchronously -
  `queued`/`running` are real states in the schema/enum but this phase's
  implementation never actually leaves a row sitting in either past the
  request that created it. A future phase moving scenario computation to a
  background job (if scenarios grow expensive - e.g. covering a much wider
  date range than their base run) would use those states for real without a
  schema change.
- A base run with zero `ForecastDataPoint` rows (e.g. still genuinely
  `queued`, no model yet) cannot be the base of a scenario -
  `SCENARIO_BASE_RUN_EMPTY` (422), no `ScenarioSimulation` row created,
  same "distinguish this from a generic 500" posture §3.3 asks for
  elsewhere.
- `volume_multiplier` allows `0` (a legitimate "what if this queue closed"
  scenario, yielding `required_headcount: 0`) but not negative values -
  validated at the API layer.
