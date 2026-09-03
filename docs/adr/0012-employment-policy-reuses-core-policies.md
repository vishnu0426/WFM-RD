# ADR-0012: `EmploymentPolicy` extends `core.policies` in place - no parallel policy table

## Context
§2.2 rule 5 requires `EmploymentPolicy` to reuse Module 01's `Policy` pattern
"rather than inventing a parallel policy engine," and says any divergence in shape
needs its own ADR. §9 separately lists "redefining... base Policy" as out of scope,
instructing this module to *extend* Module 01, not duplicate it. `EmploymentPolicy`
needs two things `core.policies` doesn't have: four new `policy_type` values
(`overtime_threshold`, `rest_period_minimum`, `max_consecutive_days`, `union_rule`)
and org-unit-level scoping (`core.policies` is tenant-wide only).

## Options considered
1. **New `org.employment_policies` table**, structurally identical to
   `core.policies` (same `policy_group_id`/version/effective-range shape) but
   physically separate. Keeps Module 02's migrations from touching Module 01's
   table, but is exactly the "parallel policy engine" §2.2 rule 5 says not to build
   - `PolicyService.GetActivePolicy` (Phase 4) would need two query paths, one per
     table, to serve "the active policy for X" regardless of which module owns the
     policy type.
2. **Extend `core.policies` in place** (chosen): add a nullable `org_unit_id`
   column and widen the `policy_type` CHECK constraint to include the four new
   values, both via an additive migration in this module.

## Decision
`core.policies` gains `org_unit_id uuid NULL` (opaque reference, no FK to
`org.org_units` - the same "no cross-module FK by design" bounded-context choice
Module 01 already made for `UserRole.scope_org_unit_id`) and an expanded
`policies_type_check` CHECK constraint. The Module 01 `Policy` TypeScript entity is
edited in place (not copied) to add the `orgUnitId` column and the `PolicyType`
enum's four new values. `EmploymentPoliciesRepository` (in `src/modules/policy/`,
alongside `PoliciesRepository`, not in `org/`) is a thin, typed view over the same
`Policy` entity, filtered to the four employment-scoped types - it extends
`TenantScopedRepository<Policy>` exactly like `PoliciesRepository` does, so both
go through the identical write guard.

This means a Module 02 migration alters a Module 01-owned table. Accepted as the
direct, intended consequence of §9's "extend, don't duplicate" instruction - the
change is purely additive (a nullable column, a widened enum), does not alter the
meaning or query shape of any existing `core.policies` row, and needs sign-off from
whoever owns Module 01's schema before this migration ships in a multi-team setting
(flagged in the production readiness checklist, not silently assumed here).

## Consequences
- `PolicyService.GetActivePolicy` (Phase 4) serves both modules' policy types
  through one query path (`Policy.policyType` + `Policy.effectiveFrom`/`effectiveTo`),
  exactly as §2.2 rule 5 asks - no second implementation to keep in sync.
- `GET /v1/policies/{policyId}/history` (Module 01 Phase 6) transparently works for
  `EmploymentPolicy` lineages too, since they're the same table with the same
  `policy_group_id` lineage key (ADR-0006) - no Module-02-specific history endpoint
  needed.
- `orgUnitId IS NULL` on a `Policy` row means tenant-wide, identically to every
  Module 01 policy type - `EmploymentPolicy` didn't introduce a second "no scope"
  convention.
- If a future employment policy type genuinely needs a shape `core.policies`'
  columns can't express (e.g. a structurally different versioning rule), *that* is
  the trigger for finally splitting into a separate table - not before, per this
  ADR's own reasoning for why a parallel table wasn't justified today.
