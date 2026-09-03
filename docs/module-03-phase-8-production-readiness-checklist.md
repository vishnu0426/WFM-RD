# Module 03 Phase 8 Production Readiness Checklist

## Delivered in this phase (application code)

- [x] Real `tft` model type (`app/ml/tft.py`, `pytorch-forecasting`) -
      fit/forecast verified for real against synthetic data (not just
      structurally reviewed), including a genuine multi-chunk rolling
      forecast past the model's trained horizon and a pickle/unpickle
      round trip.
- [x] `tft` is opt-in per `/retrain` call (`RetrainRequest.modelTypes`) -
      never attempted unless explicitly requested, never bundled into the
      default sarima/prophet/lightgbm trio.
- [x] `tft` entitlement is a hard `403 TFT_ENTITLEMENT_MISSING`, checked
      *before* the data-quality gate runs - verified against a real
      Postgres that requesting `tft` with zero `historical_actuals` seeded
      still 403s (proving the ordering), not a 422.
- [x] GPU dispatch via a Ray `num_gpus` resource request
      (`TFT_NUM_GPUS`, default `0`) - CPU-scheduled by default, matching
      what's actually verified in this sandbox (no GPU present).
- [x] `PUT /v1/forecasting/admin/tenant-settings` - `tenant_settings`' first
      real write path (migration 0004 widens its grant from SELECT-only),
      platform-admin-gated (`TenantContext.is_platform_admin`, bound since
      Phase 1's middleware, used as a real authorization check for the
      first time).
- [x] `GET /v1/forecasting/models/{orgUnitId}/provenance` - the REST audit
      trail §3.2's `forecastModelProvenance` never had a home in this repo
      (Phase 1 pushed the GraphQL version to Node/Module 01). Every
      `ForecastModel` ever trained (active/deprecated/failed), newest
      first, plus real `lightgbm`-only feature importances read off a
      persisted `Booster` - genuinely computed, not fabricated.
- [x] `/healthz` (liveness, static) + `/readyz` (real Postgres `SELECT 1` +
      NATS `is_connected` check - Postgres failure flips to 503, NATS
      failure is reported but non-blocking, mirroring Module 01's
      Redis-is-non-blocking precedent) - replacing the old bare `/health`.
- [x] `/metrics` (`prometheus-client`) - `http_request_duration_seconds`/
      `http_requests_total`, labeled by bounded-cardinality route
      *templates*, mirroring Module 01's `prom-client` conventions.
- [x] Structured JSON request logging - one line per request
      (method/path/status/duration/requestId/tenantId), a first cut for
      the platform (no prior structured-logging precedent in Module
      01/02 to diverge from).
- [x] `observability/prometheus.yml` scrapes this service's `/metrics`
      alongside Module 01/02's.
- [x] A new, separate `forecasting-service` job in
      `.github/workflows/ci.yml` (ruff, mypy --strict, unit tests) - this
      service had zero CI coverage across Phases 1-7.
- [x] 7 new unit tests (`test_tft.py` - real fit/forecast beating a naive
      baseline, confidence-interval consistency, contiguous-index
      correctness, multi-chunk rolling forecast, pickle round trip,
      insufficient-data rejection, `train_and_backtest` dispatch), 123
      total unit tests passing. Two real bugs caught and fixed by actually
      running this against real `pytorch-forecasting`, not predicted from
      documentation: (1) `TimeSeriesDataSet.from_dataset(..., predict=True)`
      silently forces exact-length predictions regardless of how the
      dataset was configured, breaking every partial final rollout chunk
      until the chunking logic was reworked to always request a full
      window and truncate; (2) unseeded PyTorch/Lightning RNG made
      training outcomes non-deterministic enough to occasionally miss
      beating a naive baseline on a small toy dataset - fixed with
      `pl.seed_everything`, a real determinism property, not just a test
      fix.
- [x] 16 new integration tests (`test_admin_api.py` - platform-admin gate,
      upsert, tenant-header fail-closed; `test_tft_entitlement.py` - 403
      before the gate even with zero data, entitled-tenant training
      success, default retrain never touches tft; `test_provenance_api.py` -
      full history ordering, real lightgbm feature importances via a fake
      that fits a genuine booster, no importances for non-lightgbm active
      models, empty-history and cross-tenant RLS cases;
      `test_health_and_metrics.py`) - **verified against the same real
      Postgres + NATS infrastructure every phase since Phase 3 used**,
      including running migration 0004 against the live shared database.
      **180 tests total (123 unit + 57 integration)** against real
      Postgres/NATS.
- [x] `ruff`/`mypy --strict` clean across `app/` and `tests/` (87 files).

## Explicitly NOT done here (needs a different owner or a later phase)

- [ ] **No scheduler reconciles `TFT_NUM_GPUS` against real cluster GPU
      capacity.** Setting it above `0` without Ray actually seeing GPU
      resources on the node makes a `tft` task queue forever - a real
      deployment's job, not tested against actual GPU hardware here.
- [ ] **TFT's own native variable-selection-network explainability** -
      `pytorch-forecasting` supports a richer `interpret_output` signal
      this phase doesn't extract; the provenance endpoint's feature
      importances are `lightgbm`-only.
- [ ] **SARIMA/Prophet explainability** - both have real, obtainable
      signals (fitted coefficients; trend/seasonality decomposition) not
      wired into the provenance endpoint this phase.
- [ ] **`tenant_settings.tft_entitled` is not reconciled with a real
      billing/entitlement system** - now writable via the admin endpoint,
      still a local stand-in, not synced with Module 01's `core.policies`
      or equivalent.
- [ ] **Envoy/gateway wiring for this service** - `envoy/envoy.yaml`
      untouched; this service isn't routed through the shared edge gateway.
- [ ] **Rate limiting** - still entirely unbuilt anywhere on this platform
      (only Envoy's coarse edge-level limiter, unrelated to per-tenant
      quotas), a gap named since Phase 1 and never closed by any phase.
- [ ] **Integration tests in CI** - the new `forecasting-service` CI job
      runs lint/typecheck/unit tests only; a live NATS JetStream service
      container wasn't stood up without a way to verify the YAML actually
      works from this environment.
- [ ] **A CI check diffing `app/db/models.py` against migration SQL.** Same
      named gap carried forward from every prior phase's checklist,
      including this one - the last phase, and still not closed.
