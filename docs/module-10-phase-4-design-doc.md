# Module 10 Phase 4 Design Doc — AI Layer: Remaining Explanation Types + Multi-Module Root Cause Analysis

**Status:** Approved for implementation
**Owner:** AI Layer pod.
**Scope:** §9's own Phase 4 line: "`explainForecast`, `reallocationRationale`, and the multi-gRPC-call `root_cause_analysis` path." Generalizes Phase 2's proven single-module pipeline (gRPC-retrieve → §5.1 assertion → BYOK provider resolve → LLM call → persist → audit) to two more owning modules, then combines two of them for the first genuinely multi-source interaction type.

## Problem

Building this phase meant checking three more owning modules for the read contracts §1 assumes exist, the same discipline Phase 2 already established (ADR-0115) — and finding the identical shape of gap each time:

1. **`explainForecast(forecastRunId)`** needs model provenance + accuracy for a specific run. forecasting-service had the data (`ForecastRun`/`ForecastModel`/`ForecastAccuracyLog`) but no single call joining them by run id. See ADR-0119.
2. **`reallocationRationale`** needs `ReallocationAction` by id. intraday-service had the data (`ai_rationale`, ADR-0070) but **no gRPC server of any kind** — this platform's only service, at this point, whose every cross-module interaction had gone outbound-only. See ADR-0120.
3. **`root_cause_analysis`** needs to combine 2+ modules for real. The natural three-source scenario (adherence + reallocation + forecast, all for one org unit/period) hit a real, distinct gap: no lookup exists anywhere in this platform for "the forecast run for org unit X in period Y" (Module 03's own run-lookup is by id only), and `ReallocationAction` has no `org_unit_id` column at all. Scoped down to two sources rather than inventing a third contract this phase didn't have a real caller to validate against. See ADR-0121/ADR-0122.

## Decisions

- **`ForecastExplanationService`/`ReallocationRationaleService`** are direct copies of `ScheduleExplanationService`'s pipeline shape against a different owning module - proof the Phase 2 pattern generalizes without modification. Neither has a write-back call (unlike scheduling's `POST .../explanation`) - neither owning module has an analogous "submit an explanation" endpoint, and none was asked for.
- **`RootCauseAnalysisService`** is the first interaction type assembling `input_context` from two gRPC calls in parallel (`Promise.all`) and asserting a multi-fact array through `TenantScopeAssertionService` (Phase 3 built and tested the mechanism; this is its first real caller). Neither source being empty is an error by itself - `RootCauseAnalysisNoDataError` only fires when both are.
- **§5.2's tenant-authored-free-text mitigation is exercised for real for the first time**, in `reallocationRationale`: `ReallocationAction.reason` is a supervisor-authored free-text field, explicitly named in the system prompt as data-to-describe, never an instruction - closing the gap Phase 2's own readiness checklist flagged as deferred until a real interaction type needed it.
- **A shared parser** (`parseLlmExplanationResponse`, replacing Phase 2's `parseScheduleExplanationResponse`) - three new callers of the identical `{summaryText, topConstraints, tradeOffs, selfReportedConfidence}` shape made the schedule-specific name and file worth generalizing, not worth copy-pasting a third and fourth time.
- **Two new gRPC clients plus one reused** (`ForecastingGrpcClientService`, `IntradayGrpcClientService`, `ComplianceGrpcClientService`) - each a thin, timeout-guarded wrapper following the exact shape ADR-0115's `SchedulingGrpcClientService` established, each throwing its own `*GrpcClientUnavailableError` on any failure (transport-level or a server-side 500 alike - no special-casing needed per source).

## Consequences / Verification

- **42 unit tests, all passing** (up from 27) - not-found, cross-tenant-rejection, happy-path, and degraded-mode cases for all three new services, plus a dedicated case proving the human-authored `reason` field passes through as plain data, never specially interpreted.
- **Real, live re-verification of the whole app**: `npm run typecheck`/`build`/`test` clean; a real `NestFactory.create` + `app.listen` boot against the same running Postgres instance succeeded with the full four-gRPC-client dependency graph resolving; the generated `src/schema.gql` inspected directly shows all four `explain*`/`rootCauseAnalysis` queries with the exact expected signatures.
- **Three cross-service additions, each independently verified**:
  - forecasting-service's `ForecastExplanationDataService`: 4/4 real gRPC tests passing against live Postgres (ADR-0119) - the *most* thoroughly verified gRPC surface in this module's own build so far, since this environment's missing ML stack (which blocks `app.main`) never blocks a gRPC-only test file.
  - intraday-service's `ReallocationService` (its first-ever gRPC server): live-boot-verified with seeded data over a real socket for both RPCs (ADR-0120), 9 new unit tests, 180 pre-existing tests unaffected (189/189 total).
  - adherence-compliance-service's `AdherenceRollupService`: 6 new unit tests, live boot succeeds, but the actual roster-fetch call depends on core's own gRPC server (confirmed unreachable in this sandbox, same gap ADR-0115 found) - disclosed, not glossed over (ADR-0121).
- **A real, pre-existing bug found in intraday-service, disclosed and NOT fixed here** (out of this phase's scope): `INestApplication.close()` never resolves once the app has called `app.listen()` - reproduced with a script containing none of this phase's own additions, proving it predates Phase 4 entirely. See the readiness checklist.
- What's next: Phase 5 (`AIGovernancePolicy` resolution, `AIRecommendation` lifecycle, the write-back-through-owning-module execution pattern for `auto_execute_low_risk`), Phase 6 (`askQuestion`), Phase 7 (the full circuit breaker), Phase 8 (prompt-injection test suite, dashboards, the real security review).
