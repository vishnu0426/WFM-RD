# Module 03 Phase 2 Design Doc — Data Quality Gate & Cold-Start Fallback

**Status:** Approved for implementation
**Owner:** Forecasting pod (Module 03)
**Scope:** §2.2's `DataQualityCheck` gate *logic* and §2.3's cold-start
similarity fallback *logic* - the two pieces Phase 1 explicitly left as
schema-only. Wires both into `POST /v1/forecasting/jobs` submission itself.
No model training (Phases 3/4/8), no Erlang C/X (Phase 5), no scenario
simulation (Phase 6), no accuracy tracking population (Phase 7).

## Problem

Phase 1 built the tables `DataQualityCheck` and `ForecastRun.is_cold_start`
needed, and ADR-0019 decided the concrete numbers the gate would enforce -
but nothing evaluated them. Building the actual logic surfaced three gaps
the source spec's §2 entity list never named (there's nowhere to check data
quality *against*, nowhere for TFT entitlement/cross-tenant opt-in to live
given ADR-0017's schema isolation, and nowhere for cold-start similarity
metadata to live given Module 02 exposes no such gRPC field) - all resolved
in ADR-0020, which this phase implements.

## Decision

Three new tables (`historical_actuals`, `tenant_settings`, `queue_profiles`,
migration `0002_phase2_gate_and_cold_start.py`), plus:

- `data_quality_service.evaluate_thresholds` - pure ADR-0019 threshold logic,
  independently unit-tested with no DB. `evaluate_gate` wraps it with the
  actual `historical_actuals`/`tenant_settings` queries and persists a
  `DataQualityCheck` row.
- `cold_start_service` - pure `similarity_score`/`time_of_week_bucket`/
  `average_samples` functions (unit-tested), plus DB-backed
  `select_similar_queues` (same-tenant only, ADR-0019's Phase 2 scope
  boundary) and `seed_cold_start_forecast` (averages up to 5 donor queues'
  actuals by time-of-week bucket into real `ForecastDataPoint` rows, ±20%
  heuristic confidence band).
- `job_service.create_job` now evaluates the gate with
  `model_type='sarima'`/`target_metric='volume'` as the run-defining
  discriminator (ADR-0020) before creating any row, and branches three ways:
  gate passes -> normal `queued` run (unchanged from Phase 1); gate fails
  with donors available -> `is_cold_start: true`, seeded synchronously,
  `status: completed`; gate fails with no donors -> `422 INSUFFICIENT_DATA`,
  no row created.
- Three new endpoints: `POST /v1/forecasting/actuals` (batch upsert, the
  landing zone for `historical_actuals`), `PUT
  /v1/forecasting/queue-profiles/{orgUnitId}` (cold-start similarity
  metadata), `GET /v1/forecasting/data-quality/{orgUnitId}` (§2.2's "surface
  the specific failure reason to the planner UI" requirement, as a real,
  queryable endpoint rather than a theoretical DB join).

## Blast radius

- Additive migration (`0002`), new tables only - no change to any Phase 1
  table's shape. `agno_forecasting_app` gains `SELECT, INSERT, UPDATE` on
  `historical_actuals` (UPDATE is required, not optional - `ingest_actuals`
  upserts via `ON CONFLICT DO UPDATE`; the migration originally granted only
  `SELECT, INSERT` and was corrected after this exact gap surfaced running
  the endpoint for real, see the Phase 3 production readiness checklist) and
  `queue_profiles`, `SELECT` (only) on `tenant_settings`.
- **Behavior change to `POST /v1/forecasting/jobs`**: a request that would
  have succeeded at `status: queued` in Phase 1 (any org unit, any amount of
  history, since nothing checked it) can now return `422 INSUFFICIENT_DATA`
  if no `historical_actuals`/`queue_profiles` data has been seeded for that
  org unit yet. This is the entire point of the phase, not an accidental
  regression - flagged here because it means Phase 1's integration tests
  (which submitted jobs for brand-new org units and expected `201 queued`)
  needed updating to seed sufficient history first, which they now do
  (`tests/integration/test_jobs_api.py`).

## Rollback plan

`downgrade()` drops the three new tables in FK-safe order
(`queue_profiles` -> `tenant_settings` -> `historical_actuals`, none of
which anything else in this schema FKs to). Reverting `job_service.py` to
its Phase 1 form (no gate call) is a code-only rollback with no migration
implication, should the gate need to be disabled without a full schema
rollback.

## Explicit assumptions (spec was ambiguous or silent here)

See ADR-0020 for the four numbered gaps and their resolutions in full. In
addition:

1. **The gate's job-submission-time discriminator model is fixed at
   `sarima`/`volume`.** Per-model-type gate evaluation (what Phase 3/4 will
   actually call before training each candidate model) remains fully
   generic in `evaluate_gate` - only the *job-submission-time* is/isn't-cold-
   start decision is pinned to SARIMA's bar.
2. **Cold-start seeding is synchronous, not queued.** Unlike real model
   training (Ray, Phase 3+), averaging up to 5 donors' actuals by
   time-of-week bucket is cheap enough to run inline during the `POST
   /v1/forecasting/jobs` request itself. If donor pools or lookback windows
   grow substantially, this may need to move to a background task - not a
   concern at this phase's scale.
3. **A donor's eligibility bar (`MIN_DONOR_WEEKS=2`, `MIN_DONOR_ROWS=20`) is
   deliberately looser than the full gate.** A donor is a *seed*, not a
   *trained model* - it doesn't need to itself pass SARIMA's 8-week bar to
   be useful as a cold-start reference point.
4. **`historical_actuals` ingestion has no authentication/authorization
   beyond tenant scoping.** Any caller holding a valid tenant context can
   write actuals for any org unit in that tenant. Matches every other
   write endpoint's current posture (ADR-0014's placeholder) - not a new gap
   introduced by this phase.

## Out of scope for this phase (do not build yet)

- Cross-tenant cold-start matching logic (`tenant_settings.
  cold_start_cross_tenant_matching_enabled` is checked nowhere) - ADR-0019's
  own pre-declared boundary, executed as planned, not newly deferred.
- LightGBM's feature-coverage sub-check - no feature-data source exists
  (Phase 4).
- An admin API for managing `tenant_settings` (TFT entitlement, cross-tenant
  opt-in) - seeded directly by an operator/migrator in this phase; a real
  admin surface (and reconciliation with Module 01's actual billing/
  entitlement source of truth) is future integration work.
- A `GET` endpoint listing `ForecastDataPoint` rows for a completed
  (including cold-start) run - `GET /v1/forecasting/jobs/{jobId}` still
  returns run metadata only, same shape as Phase 1. Adding a data-points
  listing endpoint is straightforward but wasn't named in §3.2/§3.3's Phase
  1/2 contract and is deferred rather than added speculatively.
