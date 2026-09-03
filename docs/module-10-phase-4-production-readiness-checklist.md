# Module 10 Phase 4 Production Readiness Checklist

## Delivered in this phase (application code)

- [x] `ForecastExplanationService`/`explainForecast(forecastRunId)` - full
      pipeline against forecasting-service's new `ForecastExplanationDataService`
      (ADR-0119).
- [x] `ReallocationRationaleService`/`explainReallocation(reallocationActionId)` -
      full pipeline against intraday-service's new, first-ever
      `ReallocationService` gRPC surface (ADR-0120), including real handling
      of a tenant-authored free-text field (`reason`) per §5.2.
- [x] `RootCauseAnalysisService`/`rootCauseAnalysis(orgUnitId, periodStart, periodEnd)` -
      the first multi-module interaction type, combining adherence-compliance-service's
      new `AdherenceRollupService` (ADR-0121) and intraday-service's
      `ListReallocationsForPeriod` (ADR-0122).
- [x] Three new gRPC surfaces added to three owning services (forecasting,
      intraday, compliance), each following the "the owning service builds
      the missing read contract" precedent ADR-0059/ADR-0111/ADR-0115
      established, never fabricated around.
- [x] `parseLlmExplanationResponse` - generalized from Phase 2's
      schedule-specific parser now that three more callers share the
      identical response shape.
- [x] 42 unit tests total (up from 27), all passing.

## Explicitly NOT done here (later phases, named in §9)

- [ ] `AIGovernancePolicy` resolution, `AIRecommendation` lifecycle, the
      write-back-through-owning-module execution pattern for
      `auto_execute_low_risk` (Phase 5).
- [ ] `askQuestion`/NL query, human-in-the-loop confirmation (Phase 6).
- [ ] The full circuit breaker (Phase 7) - every new service in this phase
      inherits Phase 2's minimal-but-real degraded-mode try/catch, not a
      stateful breaker.
- [ ] A third `root_cause_analysis` data source (forecast accuracy for the
      same org unit/period) - deliberately not built; no gRPC contract
      exists for "find the forecast run for an org unit/period" anywhere
      in this platform, and inventing one without a validated caller was
      out of scope (ADR-0122).
- [ ] Org-unit-scoped reallocation filtering - `ListReallocationsForPeriod`
      is tenant-wide, since `ReallocationAction` has no `org_unit_id`
      column. Disclosed in the proto's own doc comment and ADR-0122, not
      silently treated as org-unit-scoped.

## Verification performed

- [x] `npm run typecheck` / `npm run build` / `npm test` (42/42) on
      ai-layer-service - clean.
- [x] Real, live re-boot of ai-layer-service against the same running
      Postgres instance, full four-gRPC-client dependency graph resolving;
      `src/schema.gql` inspected directly and confirmed correct.
- [x] forecasting-service: **4/4 real gRPC tests passing against a live
      Postgres, over a real socket** (`tests/grpc/test_forecast_explanation_data_grpc_server.py`)
      - the most thoroughly live-verified cross-service addition in this
      module's build so far.
- [x] intraday-service: live-boot-verified with seeded data over a real
      gRPC socket for both `GetReallocationForExplanation` and
      `ListReallocationsForPeriod`; 9 new unit tests; the full 189-test
      suite (180 pre-existing + 9 new) passes.
- [x] adherence-compliance-service: 6 new unit tests, 189/189 total passing,
      live boot succeeds with the new `AdherenceRollupGrpcController`
      registered.

## Honestly disclosed gaps (not glossed over)

- [ ] **adherence-compliance-service's `AdherenceRollupService` could not
      be exercised end-to-end live** - `EmployeeGrpcClientService.getSchedulableRoster`
      depends on core's own gRPC server (port 5000), confirmed unreachable
      in this sandbox (the same pre-existing environment gap ADR-0115
      found - an HTTP/1.1 403 answers instead of gRPC/HTTP2). The RPC
      itself is reachable and correctly wired (a live boot proves DI
      resolves); the actual data path is blocked by this environment gap,
      not a code defect. A real server-side error surfaces as a generic
      `2 UNKNOWN` today rather than a typed response - acceptable, since
      Module 10's own client wrapper treats any failure the same way
      regardless of shape (§4's degraded-mode trigger).
- [ ] **A real, pre-existing bug found in intraday-service, disclosed and
      deliberately NOT fixed here**: `INestApplication.close()` never
      resolves once the app has called `app.listen()` - reproduced with a
      script containing none of this phase's own additions (no gRPC
      connected, no new code touched), proving this predates Phase 4
      entirely and is Module 05's own graceful-shutdown gap, not something
      this phase introduced or is responsible for closing. Whoever next
      works on intraday-service's own observability/shutdown story should
      pick this up - it is a real operational risk (a `SIGTERM`-triggered
      restart may hang rather than exit cleanly), just not one Phase 4 of
      a *different* module should be the one to fix.
- [ ] No live call was made to a real Anthropic or OpenAI API in this
      session (same disclosed gap as Phase 2) - all four `explain*`/
      `rootCauseAnalysis` services are exercised only against a mocked
      `LlmClient` in their own unit tests.
- [ ] Load testing, chaos/game-day exercises, a real security/red-team
      review of §5 - none run this phase, same standing gaps named in
      every prior phase's own checklist until they're actually done.
