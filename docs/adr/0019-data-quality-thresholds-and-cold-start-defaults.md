# ADR-0019: Concrete `DataQualityCheck` thresholds and cold-start defaults (Phase 2 spec, decided now)

## Context
§2.2 and §2.3 are both flagged in the source spec as needing explicit design, and
§0's own operating rule states model-quality/data-sufficiency claims must have a
stated methodology, not be vague. The *logic* implementing these is Phase 2 scope
(see the Phase 1 design doc's out-of-scope list), but the schema built in this
phase (`DataQualityCheck`, `ForecastRun.is_cold_start`) needs concrete numbers to
validate against once Phase 2 writes the gate — deciding them now, in one place,
means Phase 2 implements a spec instead of inventing numbers under implementation
pressure, and means this phase's schema (e.g. `DataQualityCheck.reason` as an
enum, not a free-text field) can be shaped around a known, finite set of failure
reasons rather than guessed at.

## Decision — minimum data volume per model type (the gate's core check)
| Model type | Minimum history | Max tolerated gap ratio | Additional requirement |
|---|---|---|---|
| `sarima` | 8 complete weeks of interval-level actuals | ≤ 5% of intervals missing in-window | — |
| `prophet` / `neuralprophet` | 12 complete weeks | ≤ 10% missing (Prophet's own interpolation tolerates gaps better, hence the looser bound) | — |
| `lightgbm` | 12 complete weeks | ≤ 10% missing | Required feature columns (campaign flags, marketing spend, weather where configured) must themselves be ≥ 90% populated over the same window, checked independently of the volume gate — a queue can pass the volume/gap check and still be ineligible for `lightgbm` specifically if its feature columns are too sparse. `lightgbm` is excluded from that queue's candidate set in that case; it does not fail the whole `DataQualityCheck` run for the other model types. |
| `tft` | 26 complete weeks | ≤ 5% missing | Tenant must hold the GPU/TFT compute entitlement (§0.5) — checked before a `tft` training job is queued at all, not just as a data-sufficiency question. A tenant without the entitlement never has `tft` attempted regardless of data volume. |

"Complete week" means every expected interval in that week has an actual value
(not a forecast, not a null) — a week with one missing day still counts toward
the gap-ratio tolerance but not toward "complete" for a stricter future
sub-check if one is added; this phase's schema stores the raw counts
(`total_expected_intervals`, `missing_intervals`) rather than a pre-computed
boolean per model type, so Phase 2's gate logic (and any future threshold change)
never needs a schema migration to adjust the numbers above — they live in Phase
2's code/config, not in the database.

`DataQualityCheck.failure_reason` is a fixed enum:
`insufficient_history | excessive_gaps | insufficient_feature_coverage |
missing_tft_entitlement` — chosen over free text so the planner UI (§2.2) can
render a specific, translatable message per reason rather than displaying raw
gate output.

## Decision — cold-start similarity fallback defaults
- **Same-tenant only by default.** Cross-tenant similarity matching (§2.3's
  "with explicit tenant opt-in, anonymized cross-tenant patterns for the same
  industry vertical") defaults to **off** for every tenant. A tenant enables it
  via an explicit, auditable policy flag (reusing Module 01's `Policy` engine
  rather than a bespoke settings table — a new `PolicyType` value,
  `cold_start_cross_tenant_matching`, following the exact precedent ADR-0012 set
  for `EmploymentPolicy` reusing `core.policies`). Flipping this flag is itself
  an `AuditLog`-worthy action given its privacy implications.
- **Similarity metadata dimensions**: industry vertical, queue type, expected
  volume band (bucketed, not raw), timezone/business-hours shape. Deliberately
  excludes anything that could re-identify a specific tenant/queue when the
  cross-tenant path is enabled (no tenant name, no raw volume, no literal
  business-hours schedule — only the shape bucketed into a small fixed set of
  categories).
- **N = 5** most-similar queues seed a cold-start forecast (source spec doesn't
  specify a number; 5 is chosen as large enough to average out one outlier
  neighbor, small enough to keep the similarity computation cheap at this
  phase's scale — revisit with real data once Phase 2 ships and has cold-start
  queues to measure against).
- **Graduation is automatic**, per §2.3: Phase 2's retraining scheduler
  re-runs the `DataQualityCheck` gate for every `is_cold_start = true`
  `ForecastRun`'s queue on the same cadence as normal retraining; the first time
  it passes, a real model trains and the next `ForecastRun` for that queue has
  `is_cold_start = false`. No manual step, no separate "graduation" endpoint.

## Consequences
- These numbers are a starting hypothesis, not a backtested claim — §0's rule
  against unstated-methodology accuracy claims applies to *these* thresholds too.
  They are the *data sufficiency* bar, not an accuracy guarantee; Phase 7's
  `ForecastAccuracyLog` is what eventually validates or revises them with real
  MAPE/WFA data, and this ADR should be revisited once that data exists.
- `DataQualityCheck` schema (Phase 1) stores raw counts + the enum reason, never
  a pre-computed per-model boolean, so this ADR's numbers can change in Phase 2
  without a migration.
- The cross-tenant opt-in's default-off posture means Phase 2's initial
  cold-start implementation only needs to build the same-tenant path to be
  complete and useful; the cross-tenant path can ship later behind the policy
  flag without blocking Phase 2.
