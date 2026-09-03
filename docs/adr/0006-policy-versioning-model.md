# ADR-0006: `policy_group_id` as the stable lineage key for `Policy` versions

## Context
§2.1's `Policy` has `version` and `effective_from`/`effective_to`, and §3.2 (Phase 6)
defines `GET /v1/policies/{policyId}/history` to reconstruct "any past effective
policy." That implies one logical policy (e.g. "Acme Corp's overtime rule") has many
row-versions, but §2.1 names no column that groups those rows together — `id` as
specified would have to be either (a) stable across versions, which breaks having a
primary key uniquely identify a row, or (b) per-version, which leaves nothing for
`{policyId}` in the URL to mean.

## Decision
Add `policy_group_id uuid NOT NULL` — the first version of a logical policy sets
`policy_group_id = id` (self-referencing lineage root); every subsequent version of
that same logical policy reuses the same `policy_group_id` with a new `id` and
incremented `version`. `{policyId}` in the REST path (Phase 6) maps to
`policy_group_id`. Uniqueness is `(tenant_id, policy_group_id, version)`.

## Consequences
- `GET /v1/policies/{policyId}/history` becomes `WHERE tenant_id = :t AND
  policy_group_id = :policyId ORDER BY version` — no recursive CTE needed.
- "Active as of timestamp T" (required by `PolicyService.GetActivePolicy`, Phase 4)
  becomes `WHERE tenant_id = :t AND policy_group_id = :g AND effective_from <= T AND
  (effective_to IS NULL OR effective_to > T)`, with a partial unique index enforcing
  at most one row per `policy_group_id` with `effective_to IS NULL` (at most one
  "current, open-ended" version at a time) — added in the Phase 1 migration since
  it's a data-integrity rule, not an application-layer nicety.
- `policy_type` stays a property of each version row (not hoisted to a separate
  "policy definition" parent table) since a policy's type is not expected to change
  across its own version history in practice; if that assumption breaks later, it's
  a straightforward additive migration, not a breaking one.
