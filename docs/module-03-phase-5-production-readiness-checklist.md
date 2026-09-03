# Module 03 Phase 5 Production Readiness Checklist

## Delivered in this phase (application code)

- [x] Real Erlang C (`app/ml/erlang.py`) - numerically stable (recursive
      Erlang-B, no factorial overflow), cross-checked against an independent
      log-space reference implementation of the textbook formula across a
      wide range of offered loads/agent counts (max abs diff ~1.6e-14).
- [x] `forecasting.service_level_targets` table + `GET`/`PUT
      /v1/forecasting/service-level-targets/{orgUnitId}` - platform defaults
      apply when unconfigured, verified live.
- [x] Both AHT and shrinkage fallback chains (`headcount_service.py`) -
      per-interval value wins, then an 8-week historical average, then (for
      shrinkage only) a stated 30% platform default. AHT has no such
      default - a queue with no AHT history anywhere gets `required_headcount:
      null`, not a guess.
- [x] Wired into both `inference_service.run_inference` and
      `cold_start_service.seed_cold_start_forecast` - `required_headcount`
      is now non-`NULL` on every `ForecastDataPoint` this service writes
      whenever volume + some AHT estimate exist.
- [x] `build_headcount_context` resolves the service-level target and
      historical AHT/shrinkage averages once per run, not once per
      interval - no N+1 query pattern.
- [x] 24 new unit tests (Erlang C math + `compute_required_headcount`'s pure
      logic), 98 total unit tests still passing.
- [x] **Verified end-to-end against the same real infrastructure Phase 3/4
      used** (shared dev Postgres, local NATS+JetStream) - all 121 tests (98
      unit + 23 integration) passing, including new assertions that
      `required_headcount` is actually populated on both the cold-start and
      model-fulfilled paths. No new infrastructure-level bugs surfaced this
      pass.
- [x] `ruff`/`mypy --strict` clean across `app/` and `tests/` (61 files).

## Explicitly NOT done here (needs a different owner or a later phase)

- [ ] **Erlang X/A (abandonment-aware headcount).** No patience/abandon
      data exists anywhere in this platform to parameterize it with (ADR-
      0023, Decision 1) - a real, named gap, not silently approximated by
      Erlang C (which assumes every call is eventually answered).
- [ ] **No admin/self-service reconciliation of `service_level_targets`
      against a tenant's real contact-center platform config** - a tenant
      configures this here independently; nothing keeps it in sync with an
      external system of record if one exists.
- [ ] **Multi-metric forecasting.** The AHT/shrinkage fallback is a
      historical average, not a forecast - a queue whose AHT is trending up
      or down won't have that reflected in `required_headcount` until Phase
      3/4's models themselves forecast AHT/shrinkage, which they still
      don't (ADR-0020/0021's carried-forward gap).
- [ ] **No REST/GraphQL endpoint lists `ForecastDataPoint` rows**, so
      `required_headcount` can only be inspected via direct DB access today
      (or eventually Node's GraphQL `ForecastRun.dataPoints` surface, not
      built in this repo).
- [ ] **A CI check diffing `app/db/models.py` against migration SQL.** Same
      named gap carried forward from every prior phase's checklist.
