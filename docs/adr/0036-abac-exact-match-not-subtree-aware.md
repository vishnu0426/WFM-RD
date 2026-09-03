# ADR-0036: ABAC scope matching is exact-org-unit-match only, not subtree-aware

## Context
§3.1's named ABAC example is "Site Supervisor scoped to their org-unit
*subtree*" - a role assignment scoped to org unit X should, ideally, also
grant access to resources scoped to X's descendants (a site supervisor's
grant should cover every team under their site, not just the site node
itself). Module 02 already has exactly the primitive this needs
(`OrgUnitsRepository.findSubtree`, an ltree `path <@ path` query,
ADR-0008) - but reaching for it directly from Module 01 would mean
querying `org.org_units` from `core`'s own authorization code.

## Decision
`AbacService.isPermittedForOrgUnit` matches only `scope_org_unit_id IS NULL`
(tenant-wide) or `scope_org_unit_id = targetOrgUnitId` (exact equality) -
not subtree membership. This is a deliberate, documented shortfall of
§3.1's stated requirement, not a hidden one: `UserRole.scope_org_unit_id`'s
own doc comment (§2.1, Phase 1) already establishes "no cross-module FK by
design" as this codebase's bounded-context rule, and subtree-aware ABAC
evaluation is exactly a case of Module 01 needing Module 02's org hierarchy
data to make a decision. Extending `AbacService` to be subtree-aware
without breaking that boundary needs a new cross-module contract - e.g. an
`OrgUnitService.IsWithinSubtree(orgUnitId, candidateId)` gRPC method Module
02 would add to its own §3.3 gRPC surface, which Module 01 would call from
`AbacService` the same way `IdentityGrpcController` is called by other
services today (ADR-0021's established pattern) - not built in this phase.

## Consequences
- A role scoped to a parent org unit does **not** currently grant ABAC
  access to that org unit's children. A tenant relying on §3.1's exact
  "site supervisor scoped to their subtree" example will need either (a)
  explicit role assignments at every org unit in the subtree they should
  cover, which works today but is an administrative burden that scales with
  hierarchy depth, or (b) the cross-module gRPC extension described above,
  which does not exist yet.
- This is listed in the production readiness checklist as a real, load-
  bearing gap for any tenant whose authorization model genuinely depends on
  hierarchy-aware scoping - not a nice-to-have polish item.
- `PolicyManagementService` is the only caller of `AbacService` in this
  phase, and every `Policy.orgUnitId` in this codebase today is either
  tenant-wide or scoped to one specific org unit with no expectation of
  cascading to children (Module 02's own `EmploymentPolicy` usage, ADR-0012,
  is exact-org-unit-scoped already) - so this gap does not silently break
  anything this phase itself ships, only a use case §3.1 names but this
  phase does not fully deliver.
