# Module 03 Phase 2 Production Readiness Checklist

## Delivered in this phase (application code)

- [x] `DataQualityCheck` gate logic (`data_quality_service.py`), threshold
      table from ADR-0019 implemented and unit-tested independent of any DB.
- [x] Cold-start similarity matching + forecast seeding (`cold_start_service.py`),
      same-tenant only per ADR-0019's scope boundary, pure scoring/bucketing/
      averaging functions unit-tested independent of any DB.
- [x] `historical_actuals` landing table + batch-upsert endpoint, the storage
      gap ADR-0020 identified (Gap 1).
- [x] `tenant_settings`/`queue_profiles` local tables (ADR-0020, Gaps 2/3),
      correct grants (`tenant_settings` SELECT-only for the app role, proven
      by `tests/integration/test_rls_isolation.py`).
- [x] `POST /v1/forecasting/jobs` wired to the gate/cold-start decision tree;
      `422 INSUFFICIENT_DATA` is now a real, reachable response, not a
      reserved-but-unused error code.
- [x] `GET /v1/forecasting/data-quality/{orgUnitId}` — the planner-UI-facing
      "why can't I get a forecast" query §2.2 asks for.
- [x] Unit tests for all pure logic (threshold rules, similarity scoring,
      time-of-week bucketing, sample averaging) + updated/expanded
      integration tests covering all three job-submission outcomes
      (queued / cold-start-completed / 422) and RLS on the two new
      tenant-scoped tables.
- [x] `ruff`/`mypy --strict` clean across `app/` and `tests/`.

## Explicitly NOT done here (needs a different owner or a later phase)

- [ ] **Cross-tenant cold-start matching.** Flag and schema exist
      (`tenant_settings.cold_start_cross_tenant_matching_enabled`); no code
      path checks it. Per ADR-0019's own pre-declared Phase 2 boundary.
- [ ] **LightGBM feature-coverage checking.** `insufficient_feature_coverage`
      stays a reserved-but-unused `DataQualityCheck.failure_reason` value
      until Phase 4 builds an actual feature pipeline to check coverage of.
- [ ] **An admin API for `tenant_settings`.** TFT entitlement and the
      cross-tenant opt-in are seeded directly by an operator today - no
      self-service or admin-role-gated endpoint exists, and no reconciliation
      with a real billing/entitlement system exists either. Flagged as a real
      integration gap, not assumed solved by the table existing.
- [ ] **A CI check diffing `app/db/models.py`'s three new classes against
      migration `0002`'s SQL.** Same named gap as Phase 1's checklist - still
      unaddressed, now with more tables to drift.
- [ ] **Reconciling `queue_profiles` with a live Module 02 feed.** Today a
      tenant re-enters industry/queue-type/volume-band/timezone metadata here
      even if equivalent `OrgUnit` metadata exists in Module 02 - no gRPC
      contract exposes it yet, so no reconciliation is possible until Module
      02 adds one.
- [ ] **Cold-start seed quality validation against real accuracy data.** The
      similarity-scoring weights and the ±20% confidence-band heuristic are
      stated, reasoned defaults (ADR-0020), not backtested. Phase 7's
      `ForecastAccuracyLog` is what will eventually validate or revise them -
      nothing does yet.
- [ ] **Load testing of the gate's `historical_actuals` queries at scale.**
      `evaluate_gate` runs two aggregate queries (`MIN`, `COUNT`) per gate
      evaluation, once per job submission - not yet measured against a
      realistically large `historical_actuals` table (millions of rows across
      many org units), so its contribution to the §0.5 job-submission-ack SLO
      (p99 < 200ms) is unvalidated.
