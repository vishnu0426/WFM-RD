# ADR-0020: Phase 2 needs three tables the source spec's §2 entity list never named, and a concrete rule for when a run counts as cold-start

## Context
Phase 2 builds the `DataQualityCheck` gate and cold-start fallback *logic*
ADR-0019 only specified thresholds/defaults for. Implementing that logic
surfaced three gaps the source spec's §2 entity list is silent on, plus one
internal inconsistency in ADR-0019 itself worth correcting rather than
carrying forward silently.

## Gap 1: there is nowhere to check data quality *against*
§2.2's gate needs "minimum historical data volume... gap detection" over
real interval-level actuals. Nothing in §2's entity list is a store of
historical actuals - `ForecastDataPoint` holds *predictions*,
`ForecastAccuracyLog` holds a prediction/actual *pair* logged after the fact
for already-completed runs. Neither is queryable as "give me every actual
volume/AHT/shrinkage data point for org unit X over the last 12 weeks,"
which is exactly what the gate needs to run at all, and what Phase 3+'s
model training will need as its training set.

**Decision**: add `forecasting.historical_actuals` (tenant_id, org_unit_id,
interval_start, actual_volume, actual_aht_seconds, actual_shrinkage_pct),
`PARTITION BY RANGE (interval_start)` monthly - same reasoning as
`forecast_data_points`/`forecast_accuracy_log` (ADR-0018), same open-ended
time-series shape. Populated via a new `POST /v1/forecasting/actuals` batch
endpoint. Where actuals originate from upstream (ACD/telephony export, a
future ingestion pipeline) is explicitly out of scope - this table and
endpoint are the landing zone, not the ingestion pipeline itself.

## Gap 2: TFT entitlement and the cross-tenant cold-start opt-in have nowhere to live
ADR-0019 said tenant TFT entitlement and cold-start cross-tenant matching
would reuse Module 01's `core.policies` engine (a new `PolicyType`, following
ADR-0012's precedent). That's unimplementable as designed: ADR-0017 grants
`agno_forecasting_app` `USAGE` on `forecasting` only, deliberately excluding
`core` - and no gRPC contract from Module 01 exposes policy lookups to this
service. Reusing `core.policies` would mean either violating ADR-0017's
isolation boundary or building a cross-service policy-lookup call that
doesn't exist anywhere in the platform yet - out of proportion for what this
phase needs.

**Decision**: `forecasting.tenant_settings` (tenant_id PK, tft_entitled bool
default false, cold_start_cross_tenant_matching_enabled bool default false).
Local to this schema, deliberately not reconciled with a real billing/
entitlement source of truth yet - `agno_forecasting_app` gets `SELECT` only
(no app-level write path in this phase; rows are seeded by
`agno_migrator`/an operator). This supersedes ADR-0019's "reuse
`core.policies`" line; ADR-0019's *thresholds and defaults* are unchanged,
only the storage mechanism for the two flags is corrected.

## Gap 3: cold-start similarity needs queue metadata this service can't read
§2.3's similarity dimensions (industry, queue type, expected volume band,
timezone/business-hours shape) are `OrgUnit`-adjacent metadata that would
naturally live in Module 02's schema - but per the Phase 1 design doc,
Module 03 does not read `org.*` directly, and Module 02 exposes no gRPC field
for "industry" or "queue type" today (`EmployeeService`/`CalendarService`
cover headcount and working-time calendars, not queue classification).

**Decision**: `forecasting.queue_profiles` (tenant_id + org_unit_id PK,
industry, queue_type, expected_volume_band, timezone_bucket). Local to this
schema, populated via `PUT /v1/forecasting/queue-profiles/{orgUnitId}` -
tenant-scoped, low-stakes metadata, not gated the way `tenant_settings` is.
Reconciling this with a live Module 02 feed (so a queue's profile doesn't
need re-entering here) is flagged as future integration work, not solved now.

## Decision: which model type's threshold decides `is_cold_start`
`ForecastRun` carries one `forecast_model_id`/one `is_cold_start` flag, but
§2.2's gate is inherently per-model-type (SARIMA's bar is looser than TFT's).
At job-submission time, no model has been selected yet (that's Phase 3/4's
best-fit competition). Something has to decide, at submission time, whether
*this run* is cold-start.

**Decision**: the gate is evaluated with `model_type='sarima'` (the loosest
non-TFT bar, ADR-0019's table) against `target_metric='volume'` (the
run-defining metric - `interval_minutes`/`date_range` on `ForecastRun` are
volume-shaped, and AHT/shrinkage forecasting for the same interval piggyback
on the same run in this schema). If even SARIMA's 8-week/5%-gap bar fails,
the run needs cold-start; if it passes, the run is not cold-start, and which
of SARIMA/Prophet/LightGBM eventually gets selected is unchanged, deferred
Phase 3/4 scope. `DataQualityCheck.evaluate_gate` itself remains generic over
`model_type` (Phase 3/4 will call it again per model type at training time,
independent of this job-submission-time discriminator).

## Decision: what happens to `POST /v1/forecasting/jobs` when the gate fails
Two outcomes, both synchronous (no queued-then-silently-stuck state):
1. **Gate fails, same-tenant donor queues exist** (`queue_profiles` similarity
   match against queues with their own sufficient `historical_actuals`): the
   run is created with `is_cold_start = true`, seeded immediately (cold-start
   seeding is a cheap local computation, not a training job - no Ray
   dependency), and returned as `status: completed`.
2. **Gate fails, no donors exist**: `POST /v1/forecasting/jobs` returns `422
   INSUFFICIENT_DATA` (the code/status already reserved in Phase 1's
   `errors.py`) with no `ForecastRun` row created. §3.3's own cross-cutting
   requirement ("error codes distinguishing INSUFFICIENT_DATA from a generic
   500") anticipated exactly this on this exact endpoint - this is not a
   deviation from the async-job contract, it's the contract's own named
   failure mode.

## Consequences
- Three new local tables are, by construction, a duplication/staleness risk
  against whatever Module 01/02 eventually become the real source of truth
  for tenant entitlements and org-unit metadata. Flagged explicitly in the
  production readiness checklist, not hidden.
- Cold-start seeding's actual method (average of similar queues' actuals at
  matching day-of-week/time-of-day, ±20% heuristic confidence band) is a
  coarse, stated heuristic, not a backtested claim - consistent with §0's
  rule that data-sufficiency/accuracy claims need a stated methodology.
  Phase 7's `ForecastAccuracyLog` is what eventually validates or revises it.
- LightGBM's feature-coverage sub-check (ADR-0019's table) is not
  implemented in this phase - no feature-data source (campaign flags,
  marketing spend) exists yet to check coverage of. `evaluate_gate` accepts
  `model_type='lightgbm'` and applies its volume/gap thresholds only;
  `insufficient_feature_coverage` stays a reserved-but-unused enum value
  until Phase 4 builds LightGBM's actual feature pipeline.
- Cross-tenant cold-start matching remains flag-and-schema-only, per
  ADR-0019's own pre-declared scope boundary - not newly deferred by this
  ADR, just executed as originally planned.
