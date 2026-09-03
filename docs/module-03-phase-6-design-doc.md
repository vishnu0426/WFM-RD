# Module 03 Phase 6 Design Doc — Scenario Simulation

**Status:** Approved for implementation
**Owner:** Forecasting pod (Module 03)
**Scope:** `POST`/`GET /v1/forecasting/scenarios` producing a real
`ForecastRun` from an existing base run's data, adjusted by
`assumption_overrides`. No accuracy tracking population (Phase 7), no
TFT/GPU (Phase 8).

## Problem

`ScenarioSimulation` has existed as a table since Phase 1, explicitly
scoped as "schema now, endpoint in Phase 6" (the Phase 1 design doc's own
assumption #6). §7 names the deliverable as "`ScenarioSimulation` producing
a real `ForecastRun`, same read path as live forecasts" - which decides
less than it sounds like: it doesn't say whether a scenario re-runs a model
or just adjusts existing numbers, and `assumption_overrides` (jsonb, "e.g.
volume_multiplier, aht_delta") has no defined shape or semantics anywhere
else in the spec.

## Decision

See ADR-0024 for the four numbered decisions in full. Summary:

- Scenarios are **arithmetic over an existing base run's
  `ForecastDataPoint` rows**, not a re-forecast - no Ray, no MLflow, no
  2-minute SLO. `volume_multiplier` (multiplicative), `aht_delta_seconds`/
  `shrinkage_delta_pct` (additive) apply per interval.
- Before applying deltas, each point's AHT/shrinkage is **resolved** (its
  own value, or the same historical fallback Phase 5's `headcount_service`
  would use) - so a scenario off a model-fulfilled base run (whose own AHT/
  shrinkage columns are `NULL`) still produces a real adjusted number, and
  the resolved-and-adjusted value is what gets stored (not `NULL`) - a
  scenario's job is to show what was assumed.
- Confidence bounds scale with `volume_multiplier` - a stated heuristic
  (no underlying model fit exists to ask for a real interval on the
  hypothetical).
- `required_headcount` is recomputed via the same `headcount_service.
  compute_required_headcount` Phase 5 built, using the adjusted volume/AHT/
  shrinkage and the org unit's real `service_level_targets`.
- The result run publishes the same `agno.forecasting.run.completed.v1`
  event a live forecast does.

## Blast radius

- No migration - `ScenarioSimulation` already existed. New application code
  only: `app/ml/scenario.py`, `app/services/scenario_service.py`,
  `app/api/v1/scenarios.py`, two new `DomainError` subclasses.
- Reuses `headcount_service.build_headcount_context` and
  `compute_required_headcount` unchanged - no changes to Phase 5's code.

## Rollback plan

Removing the `scenarios` router from `main.py` and reverting
`ScenarioSimulation`-writing code is code-only - the table itself predates
this phase and nothing else depends on rows it contains.

## Explicit assumptions (spec was ambiguous or silent here)

See ADR-0024 in full; additionally:

1. **`assumption_overrides`' three fields (`volumeMultiplier`,
   `ahtDeltaSeconds`, `shrinkageDeltaPct`) are this phase's entire
   vocabulary.** The source spec's "e.g." wording implies more might exist
   (interval-specific overrides, a subset-of-date-range override) - not
   built; a scenario always covers the base run's full date range with one
   flat multiplier/delta set, not per-interval overrides.
2. **A scenario has no independent `interval_minutes`/`date_range` inputs**
   - both are copied from the base run. A caller wanting a different range
   creates a new base `ForecastRun` first (via `/jobs`), not by rescoping a
   scenario.
3. **`created_by` is not tracked on the result `ForecastRun`** (`None`) -
   consistent with `job_service.create_job`'s own current placeholder
   posture (ADR-0014's caveat about no real actor identity existing yet).

## Out of scope for this phase (do not build yet)

- Per-interval or partial-date-range assumption overrides.
- Scenario comparison/diff views (e.g. "show me base vs. scenario side by
  side") - Node's GraphQL surface's job, fed by this service's two
  `ForecastRun`s, not built here.
- Async/queued scenario computation for a future case where scenarios grow
  expensive (e.g. covering a much longer range than their base run) -
  `ScenarioSimulation.status`'s `queued`/`running` states exist in the
  schema but nothing in this phase's implementation ever leaves a row in
  either state past the request that created it.
