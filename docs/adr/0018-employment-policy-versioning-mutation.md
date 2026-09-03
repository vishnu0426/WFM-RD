# ADR-0018: `createEmploymentPolicy` handles both new lineages and new versions, keyed by an optional `policyGroupId`

## Context
§3.1 names `createEmploymentPolicy` as the one mutation for `EmploymentPolicy`, but
ADR-0006's versioning model (inherited via ADR-0012) means a "policy" is really a
lineage of versions sharing a `policyGroupId`, with at most one version having
`effectiveTo IS NULL` (`uq_policies_one_open_version`, Phase 1). A single
"create" mutation has to account for both "this is a brand-new policy" and "this
supersedes the currently active version of an existing policy" - §3.1 doesn't
distinguish the two with separate mutations.

## Decision
One mutation, `createEmploymentPolicy(input: CreateEmploymentPolicyInput!)`, where
`input.policyGroupId` is optional:
- **Omitted**: starts a new lineage. `id` is generated client-side (`uuidv4()`,
  matching `EmployeesRepository.create`'s existing determinism reasoning) and
  `policyGroupId := id` (ADR-0006's "first version sets policy_group_id = id" rule),
  `version: 1`.
- **Supplied**: must reference an existing lineage with a currently open version
  (`EmploymentPoliciesRepository.findOpenVersion`) - otherwise `EmploymentPolicyNotFoundError`.
  `EmploymentPoliciesService.create` closes that version (`effectiveTo :=
  input.effectiveFrom`) and inserts a new row in the same lineage with
  `version: openVersion.version + 1`, *before* the new row's insert - so
  `uq_policies_one_open_version` never has a window where the constraint would be
  violated even transiently within the same transaction.

## Consequences
- No separate `updateEmploymentPolicy`/`supersedeEmploymentPolicy` mutation exists or
  is needed - superseding *is* calling `createEmploymentPolicy` again with the prior
  call's `policyGroupId`.
- `orgUnitId` and `policyType` are **not** re-validated against the prior version when
  continuing a lineage - a caller could in principle change `orgUnitId` mid-lineage.
  Nothing in §2.1/§3.1 says a lineage's scope must stay fixed across versions, so this
  is left permissive rather than adding an unrequested restriction; if that turns out
  to be wrong, it's a validation-only fix in `EmploymentPoliciesService.create`, not a
  schema change.
- `EmploymentPolicyType` (a 4-value enum) vs. `PolicyType` (9 values across both
  modules) is a real nominal-typing seam at the GraphQL boundary - `EmploymentPolicyResolver`'s
  `toGraphQLType` cast exists because TypeScript can't see that
  `EmploymentPoliciesRepository`'s queries already filter to the compatible subset.
  If a future phase adds a fifth employment-scoped policy type, both enums need the
  addition kept in sync by hand - nothing enforces that automatically today.
