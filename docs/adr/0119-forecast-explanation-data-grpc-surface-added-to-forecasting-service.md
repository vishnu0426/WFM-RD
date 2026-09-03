# ADR-0119: `ForecastExplanationDataService` — a new gRPC surface added to forecasting-service, joining `ForecastRun`→`ForecastModel`→`ForecastAccuracyLog`

## Context
Phase 4's `explainForecast(forecastRunId)` needs "model provenance and accuracy" for a forecast run - §1's own framing names `ForecastDataPoint`/model provenance from Module 03 as the expected input. Checking forecasting-service's real gRPC/REST surface first (the same discipline ADR-0059/ADR-0111/ADR-0115 already established):

- The only existing gRPC surface, `ForecastService.GetForecastRequirements` (ADR-0059), returns per-interval `required_headcount` only - no model, no accuracy.
- REST has three separate partial views: `GET /v1/forecasting/jobs/{jobId}` (run status/dates, no model/accuracy), `GET /v1/forecasting/accuracy/{orgUnitId}` (accuracy, but keyed by org unit not run id), `GET /v1/forecasting/models/{orgUnitId}/provenance` (model history, also keyed by org unit not run id).
- No single call answers "for THIS forecast run, what model produced it and how accurate has it been" - exactly the gap `explainForecast` needs closed, and exactly the shape of gap this platform's own precedent says to close in the owning service, not fabricate around.

## Decision
Add `agno.forecasting.v1.ForecastExplanationDataService.GetForecastRunForExplanation` to forecasting-service - a second gRPC servicer, same process/port as `ForecastService` (no new CPU-bound work, a plain three-table join by id). Joins `ForecastRun` → `ForecastModel` (via the nullable `forecast_model_id` FK) → `ForecastAccuracyLog` (by `forecast_run_id`, ordered by `evaluated_at`).

`has_model: false` (not a synthetic model row) when `forecast_model_id IS NULL` - a cold-start or not-yet-model-backed run is a real, distinct state `explainForecast`'s own prompt needs to describe honestly ("no model linked yet"), not paper over with empty strings that look like a real-but-blank model.

## Consequences
- forecasting-service gains its second gRPC surface and its second generated-stub pair, following the exact `grpc_tools.protoc` + manual `from . import` fix convention `forecast.proto` already documents.
- **Verified for real, against a live Postgres, over a real gRPC socket** - `tests/grpc/test_forecast_explanation_data_grpc_server.py`, 4/4 passing (found-with-model, found-without-model, not-found, wrong-tenant), following `test_forecast_grpc_server.py`'s own established pattern (deliberately outside `tests/integration/`, whose `conftest.py` imports this service's full ML stack). This is stronger verification than ADR-0115's own scheduling-service surface got, purely because this environment's `torch`/`ray`/etc. absence never blocks a gRPC-only test file the way it blocks `app.main`.
- No write-back call exists or was asked for - forecasting-service has no analogous "submit an explanation" endpoint the way scheduling-service does (ADR-0059's Phase 6 handoff); `explainForecast` is read-only from Module 03's perspective.
