# Module 09 Phase 5 Design Doc — Analytics & Reporting: Custom Metric Validation Pipeline

**Status:** Approved for implementation
**Owner:** Analytics & Reporting pod (Module 09).
**Scope:** §8's own Phase 5 line: "Custom metric validation pipeline. §0.5/§2.3's dry-run and cost-tiering gate for tenant-authored `calculation_definition`." Concretely: `MetricValidationService` (the dry-run/cost-tiering gate), `MetricDefinitionService.createMetricDefinition` (the write path Phase 5 needed to have any real effect - §4.1 never named one), and `DashboardService`'s widget guard extended to also reject an unvalidated metric.

## Problem

Designing the actual gate surfaced a question the source spec's own §0.5/§2.3 framing doesn't answer: **what can a tenant-authored `calculation_definition` actually contain, given this platform's real architecture?** Phase 4's `MetricQueryEngineService` already validates every `calculationDefinition.sourceView`/`valueColumn` against a hardcoded whitelist (`SOURCE_VIEW_REGISTRY`) before building any SQL - there is no code path anywhere in this service that turns an arbitrary jsonb blob into dynamically-constructed SQL. A tenant cannot express a new formula; only "this already-computed column, filtered by these already-supported dimensions." This is a direct, correct consequence of §0's own non-negotiable (Module 09 must never re-derive a fact another module owns) - see **ADR-0110** for the full reasoning, including why every dry-run-tiered metric on this platform today will measure `'cheap'` by construction (every whitelisted source is a pre-computed, tenant-id-indexed rollup table) and why the gate is still real and worth building regardless (it protects against a *future* source view that might not carry the same indexing discipline, and it is measured, not asserted).

A second finding: **§4.1 never named a mutation for creating a `MetricDefinition` at all.** Without one, this phase's own validation pipeline would have nothing to validate. `createMetricDefinition` is added here as a structurally necessary write path - the same "add what a described capability structurally requires" precedent as `saved_report.name` (Phase 4) or `ComplianceReport.status` (Module 08).

A third, smaller finding while extending `DashboardService`'s widget guard: Phase 4's guard only checked `estimatedCostTier === 'expensive'`, because nothing before this phase could ever produce a `MetricDefinition` row with `validatedAt: null` - Phase 4's own six seeded metrics were all validated (asserted, not dry-run) at migration time. This phase's `createMetricDefinition` always validates before insert too (rejecting outright on failure - nothing is ever stored unvalidated), so in *current* practice no write path can produce an unvalidated row either. The guard against `validatedAt: null` is real, tested code (verified directly against a manually-crafted unvalidated row, since no normal write path can reach that state) - defense-in-depth against a future write path that might bypass this service, not a defense against something reachable today.

## Decision

**`MetricValidationService.validateAndTier(tenantId, metricName, calculationDefinition)`**:
1. Structural check against `SOURCE_VIEW_REGISTRY` (`sourceView`/`valueColumn`/any `dimensions` entries) - the identical whitelist `MetricQueryEngineService` checks at query time, imported once, never duplicated.
2. A real, bounded dry-run (`SELECT {valueColumn} FROM {table} ORDER BY period_start DESC LIMIT 5`) via `ANALYTICS_APP_REPLICA_PG_POOL`/`withTenantScopedClient` - the same RLS-scoped read path a live widget would use, at a smaller limit. A definition that is whitelist-legal but fails at runtime for any other reason is rejected here, not discovered on a dashboard's first real load.
3. Cost-tiering by measured wall-clock duration of that dry-run: `< 100ms` → `cheap`, `100–1000ms` → `moderate`, `> 1000ms` → `expensive` - disclosed placeholder thresholds (ADR-0110), revisited with Phase 8's real load-test numbers, not guessed here.
4. `validatedAt`/`estimatedCostTier` are set together, only on success; any failure throws (`MetricSourceNotAllowedError` for the whitelist check, `MetricValidationFailedError` for a dry-run that throws) - never a partially-validated row.

**`MetricDefinitionService.createMetricDefinition`**: validates first, then checks for a tenant-scoped name collision (`MetricNameAlreadyExistsError` - proactive check against §2.1's own uniqueness index, not a caught Postgres unique-violation), then inserts via `withTenantConnection` (the primary, same convention as `DashboardService`).

**`DashboardService`'s widget guard** now checks `validatedAt` before `estimatedCostTier` - an unvalidated metric is rejected the same way an expensive one is.

**`createMetricDefinition` needs no actor identity** - unlike `SavedReport`, `MetricDefinition` has no `createdBy`/ownership concept in §2.1's own schema; only a tenant.

## Blast radius

- New: `MetricValidationService`, `MetricDefinitionService`, one new metric (`analytics_metric_definition_validations_total`), three new `DomainError` subclasses (`MetricValidationFailedError`, `UnvalidatedMetricNotAllowedOnWidgetError`, `MetricNameAlreadyExistsError`), `createMetricDefinition` GraphQL mutation + its input/result types.
- `DashboardService.assertWidgetMetricUsable` gains one new check (additive - the existing expensive-metric check is unchanged).
- Zero modification to any Module 02–08 table, migration, schema, or running code. No new migration - Phase 4's `metric_definition.validated_at`/`estimated_cost_tier` columns already exist and are nullable.
- `docker-compose.yml`/`scripts/init-roles.sql`: no change - reuses `ANALYTICS_APP_REPLICA_PG_POOL` (Phase 4's own provider), no new role.

## Rollback plan

Revert `AnalyticsModule`'s two new providers, remove `createMetricDefinition` from `MetricResolver`, revert `DashboardService`'s guard to its Phase 4 shape, revert `DomainErrorFilter`'s three new entries, remove this doc, its checklist, and ADR-0110. Nothing outside this service depends on this phase's surface yet, and no schema change to revert.

Verified against a real local Postgres, the same real replica Phase 2 stood up, and real GraphQL requests: `createMetricDefinition` with a whitelist-legal `calculationDefinition` succeeds, dry-run-measures `'cheap'`, and is immediately queryable via `metricQuery` for the real seeded value; an invalid `valueColumn` is rejected with `METRIC_SOURCE_NOT_ALLOWED`; a duplicate name for the same tenant is rejected with `METRIC_NAME_ALREADY_EXISTS`; a manually-crafted unvalidated `MetricDefinition` row (inserted directly via SQL, since no real write path can produce one) is correctly rejected by `createDashboard`'s widget guard with `UNVALIDATED_METRIC_NOT_ALLOWED_ON_WIDGET`. 110 unit tests pass (up from 97 in Phase 4), lint/typecheck/build clean.

## Explicit assumptions (spec was ambiguous or silent here)

1. **A tenant-authored metric is a named view onto an already-whitelisted source-view column, never an arbitrary formula** - see ADR-0110 in full.
2. **`createMetricDefinition` is a new mutation this phase adds** - §4.1 never named one.
3. **Cost-tier thresholds (`100ms`/`1000ms`) are disclosed placeholders**, not load-tested constants - see ADR-0110.
4. **Every dry-run-tiered metric on this platform today measures `'cheap'`** - a structural consequence of the whitelist's own design (every source is a pre-computed, indexed rollup table), not evidence the gate is untested or inert.
5. **This module's six Phase-4 platform-default metrics are not retroactively re-validated through this pipeline** - they remain asserted (`'cheap'`, set directly by that migration), not dry-run-measured.

## Out of scope for this phase (do not build yet)

- Any REST surface for `createMetricDefinition` - GraphQL only, matching `createDashboard`'s own precedent.
- Re-validating a `MetricDefinition` after the fact (e.g. if the underlying view's shape changes) - no such trigger exists; a metric is validated once, at creation.
- `createScheduledExport` - Phase 6.
- `askAnalyticsQuestion` - Phase 7.
- The §0.5 load test that would give this phase's placeholder cost-tier thresholds real numbers to check against - Phase 8.
