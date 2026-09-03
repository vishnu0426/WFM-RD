# Module 03 Phase 8 Design Doc — TFT Tier (GPU-Gated), Explainability/Provenance API, Observability + Hardening

**Status:** Approved for implementation
**Owner:** Forecasting pod (Module 03)
**Scope:** the final phase - a real, opt-in `tft` model tier gated by
`TenantSettings.tft_entitled`; a REST audit-trail/explainability endpoint
over already-retained `ForecastModel` history; `/healthz`+`/readyz`+
`/metrics`+structured logging; a first CI job for this service.

## Problem

§7 names Phase 8 as "TFT tier (GPU-gated), explainability/provenance API,
observability/hardening" - the broadest scope of any phase, and the only
one spanning three genuinely separate concerns at once. Every prior
phase's checklist named pieces of this as a stated, deferred gap: GPU/TFT
entitlement enforcement (scaffolded since Phase 1's `TftEntitlementMissingError`
and Phase 2's `TenantSettings.tft_entitled`, never wired to anything real),
§3.2's `forecastModelProvenance` (explicitly pushed to Node/Module 01's
GraphQL surface in Phase 1's own design doc, never given a REST home in
this repo), and no structured logging, `/metrics`, real dependency health
checks, or CI wiring for this service across seven prior phases.

## Decision

See ADR-0026 for the full seven-decision breakdown. Summary:

- **TFT via `pytorch-forecasting`**, verified for real in this sandbox
  (CPU wheel installs and trains correctly - `torch.cuda.is_available()`
  is `False` here, confirmed directly). Explicitly opt-in per `/retrain`
  call (`RetrainRequest.modelTypes`) - never bundled into the default
  sarima/prophet/lightgbm trio, both for cost-model honesty (§0.5) and
  because `pytorch-forecasting` fixes a model's prediction horizon at
  training time, unlike the other three.
- **`forecast_tft` rolls forward past its trained horizon** in
  `holdout_periods`-sized chunks, each conditioned on the previous chunk's
  own median prediction - a stated, real accuracy tradeoff for long-horizon
  `tft` requests, not hidden.
- **`FittedTft` (state_dict + dataset spec), not the live model, gets
  pickled** - a live `TemporalFusionTransformer` cannot be pickled at all
  (`AttributeError` on a real fitted model, found by testing it directly),
  so the standard PyTorch persistence pattern applies instead.
- **GPU dispatch is a Ray `num_gpus` resource request**
  (`TFT_NUM_GPUS`, default `0`) - CPU-scheduled by default, matching what's
  actually verified here; a real GPU deployment opts in via one env var.
- **`tft` entitlement is a hard 403, checked before the data-quality
  gate** - `TftEntitlementMissingError`, scaffolded since Phase 1 and never
  thrown until now. `tenant_settings` gets its first real write path
  (`PUT /v1/forecasting/admin/tenant-settings`, platform-admin-gated),
  closing ADR-0020 Gap 2.
- **Provenance is a REST audit trail**, not a new table:
  `GET /v1/forecasting/models/{orgUnitId}/provenance` returns every
  `ForecastModel` ever trained for an org unit (ADR-0021 Decision 3 already
  keeps them all), plus real `lightgbm`-only feature importances - a named,
  asymmetric gap for the other three model types.
- **`/healthz`+`/readyz`+`/metrics`+structured JSON logging**, mirroring
  Module 01's liveness/readiness split and `prom-client` conventions where
  one already exists, introducing a first cut where none did (structured
  logging).

## Blast radius

- One migration (0004): widens `tenant_settings`' grant from `SELECT`-only
  to `INSERT, UPDATE` - no new tables.
- New dependencies: `torch`, `pytorch-forecasting`, `lightning` (lazy
  imports, ADR-0021 Decision 5 convention), `prometheus-client` (imported
  at module top level, unlike the ML libraries - small, no heavy native
  deps, needed reachable at startup for `/metrics`).
- `training_service.retrain` gains an optional `model_types` parameter -
  every existing caller keeps working unchanged by omitting it.
- `ray_orchestrator.train_candidates_in_parallel`'s candidate tuple shape
  is unchanged; the GPU resource decision is made from `model_type` alone
  inside the orchestrator.
- The old bare `/health` route is removed, replaced by `/healthz`+`/readyz`.
- `observability/prometheus.yml` gains a second scrape job for this
  service's own `/metrics`. `envoy/envoy.yaml` is deliberately untouched
  this phase (see ADR-0026, Decision 7).
- `.github/workflows/ci.yml` gains a new, separate `forecasting-service`
  job (lint/typecheck/unit tests only - integration tests need a live
  NATS this job doesn't stand up, a stated gap).

## Rollback plan

Removing the `admin` router, the `models` router's `/provenance` route,
`/healthz`/`/readyz`/`/metrics`, `MetricsMiddleware`, and reverting
`TenantContextMiddleware`'s logging addition are all code-only. The `tft`
model type and its entitlement gate can be removed by reverting
`training_service.retrain`'s `model_types` parameter and
`app/ml/tft.py`/`app/ml/training.py`'s dispatch branch - `TenantSettings.tft_entitled`
predates this phase and nothing else depends on its value. Migration 0004
is a pure grant widening; downgrading it (`REVOKE`) is safe as long as the
admin endpoint is removed first.

## Explicit assumptions (spec was ambiguous or silent here)

See ADR-0026 in full; additionally:

1. **`forecast_tft`'s rolling-rollout chunk size is always the *full*
   `max_prediction_length`, even for a final partial chunk** - discovered
   the hard way: `TimeSeriesDataSet.from_dataset(..., predict=True)`
   silently forces `min_prediction_length = max_prediction_length`
   internally regardless of how the dataset was configured at training
   time, so a combined encoder+future frame shorter than the full trained
   window is rejected outright. Every chunk (including the last) requests
   a full-length prediction and is truncated to what's actually needed -
   not a design choice, a library constraint worked around correctly once
   understood.
2. **`fit_tft` seeds PyTorch/Lightning's RNG (`pl.seed_everything`)** -
   without it, the exact same training data can produce a materially
   different fitted model (and, on a small/undertrained toy dataset,
   sometimes fails to beat even a naive baseline) run to run. A production
   forecasting service should get the same model back for the same input,
   not a different one by chance each retrain - this is a real correctness
   property, not just a test-flakiness fix (though it was found as one).
3. **The provenance endpoint's `history` is not filtered by model status**
   - active, deprecated, and failed rows all appear, newest first. A
   caller wanting "just the active model" already has
   `GET /v1/forecasting/models/{orgUnitId}` (unchanged) or can filter
   client-side; provenance's whole point is showing the full trail.
4. **CI's new Python job runs unit tests only**, not integration tests -
   standing up a reliable NATS JetStream service container in GitHub
   Actions is real, doable work this phase doesn't attempt without a way
   to verify the YAML actually works end-to-end from here.

## Out of scope for this phase (do not build yet)

- A scheduler reconciling `TFT_NUM_GPUS` against real cluster GPU capacity.
- TFT's own native variable-selection-network explainability output (a
  real, richer signal `pytorch-forecasting` supports but this phase
  doesn't extract).
- SARIMA/Prophet explainability (coefficients / trend-seasonality
  decomposition - both real, obtainable, not built this phase).
- Reconciling `tenant_settings.tft_entitled` with a real billing/entitlement
  system - still a local stand-in, now writable but not synced anywhere.
- Envoy/gateway wiring, rate limiting (still unbuilt anywhere on this
  platform), a CI schema-drift check (carried forward since Phase 1),
  integration tests in CI.
