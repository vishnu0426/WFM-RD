# ADR-0011: `ErasureRequest` - Phase 1 ships the mechanism's schema, not the anonymization workflow

## Context
§2.4 requires `ErasureRequest` to exist "from day one (not retrofitted)" alongside
the other §2 entities, while §8 explicitly scopes the actual field-by-field
anonymization logic to Phase 8, and §2.4/§9 both flag that legal sufficiency of the
workflow is a legal/compliance decision this codebase does not get to make.

## Decision
Phase 1 ships the `ErasureRequest` table and entity (`id`, `tenant_id`,
`employee_id`, `requested_by`, `requested_at`, `legal_basis`, `status`,
`completed_at`) plus a `TenantScopedRepository`-based `ErasureRequestsRepository`
exposing only lifecycle reads/writes (create a request, look up by employee) - no
anonymization logic, no field-by-field redaction rules, no status-transition
side-effects. `status = 'completed'` is representable in the schema now (with a
`CHECK` tying it to `completed_at IS NOT NULL`) so Phase 8 has a stable contract to
build against, but nothing in this phase actually performs an erasure.

`legal_basis` is `varchar`, not an enum: which bases are legally valid (GDPR Art.
17 exceptions, local labor-law retention requirements, etc.) is exactly the kind of
determination §2.4 flags as out of engineering's hands. Constraining it to an enum
here would silently encode a legal position this schema has no authority to take.

## Consequences
- No employee data is ever anonymized by anything shipped in this phase - creating
  an `ErasureRequest` row today has no observable effect on `Employee`/`EmployeeSkill`/
  history data. That's intentional, not an oversight.
- Phase 8 owns: the field-by-field anonymization rule per table (§2.4 requires this
  be explicit, table-by-table, not "we'll anonymize it"), the trigger/service that
  runs it on `status` transitioning to `completed`, and the integration with Module
  01's `AuditLog` for auditing the erasure action's metadata (not the erased PII
  itself, per §2.4).
- Explicitly flagged, again, per §2.4 and §9: this ADR and the schema it describes
  implement a mechanism. They do not constitute, and should not be read as, a
  completed GDPR compliance program. That sign-off is a separate legal process.
