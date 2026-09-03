# Module 03 Phase 6 Production Readiness Checklist

## Delivered in this phase (application code)

- [x] `POST /v1/forecasting/scenarios` - real arithmetic over an existing
      base run's `ForecastDataPoint` rows (`volumeMultiplier`/
      `ahtDeltaSeconds`/`shrinkageDeltaPct`), producing a genuine new
      `ForecastRun` + `ForecastDataPoint` set, `status: completed`
      synchronously.
- [x] `GET /v1/forecasting/scenarios/{id}` - poll contract, matching the
      rest of this service's async-job shape even though this phase always
      resolves synchronously.
- [x] AHT/shrinkage resolved (own value or Phase 5's historical fallback)
      *before* applying override deltas, and the resolved-and-adjusted
      value is stored - not `NULL`, even when the base run's own column was.
- [x] `required_headcount` recomputed via the same `headcount_service`
      Phase 5 built - no duplicated Erlang C logic.
- [x] Two new, real `DomainError`s (`SCENARIO_BASE_RUN_EMPTY` 422,
      reused `NOT_FOUND` 404 for a missing/cross-tenant base run) -
      distinguishable from a generic 500 per §3.3's own requirement.
- [x] The result run publishes the same `agno.forecasting.run.completed.v1`
      event a live forecast completion does.
- [x] 8 new unit tests (`apply_overrides` pure math - no-op, multiplier,
      zero-volume "queue closes" case, additive AHT/shrinkage deltas with
      clamping, `None`-input passthrough), 106 total unit tests passing.
- [x] 5 new integration tests (volume-multiplier scaling verified against
      real stored data points, GET-after-POST, missing/empty/cross-tenant
      base run rejections) - **verified against the same real Postgres +
      NATS infrastructure Phases 3-5 used**, no new infrastructure bugs
      surfaced this pass (built cleanly on the already-verified foundation).
      134 tests total (106 unit + 28 integration).
- [x] `ruff`/`mypy --strict` clean across `app/` and `tests/` (67 files).

## Explicitly NOT done here (needs a different owner or a later phase)

- [ ] **Per-interval or partial-date-range assumption overrides.** A
      scenario always applies one flat multiplier/delta set across the
      base run's entire date range.
- [ ] **A comparison/diff view (base vs. scenario side by side).** Both are
      independently readable `ForecastRun`s via the existing `/jobs/{id}`
      endpoint; nothing renders them together. Node's GraphQL surface's job.
- [ ] **Async/queued scenario computation.** `ScenarioSimulation.status`'s
      `queued`/`running` states exist in the schema (Phase 1) but this
      phase's implementation never actually uses them - only relevant if
      scenarios grow expensive enough to need it (e.g. a much longer range
      than typical).
- [ ] **A CI check diffing `app/db/models.py` against migration SQL.** Same
      named gap carried forward from every prior phase's checklist.
