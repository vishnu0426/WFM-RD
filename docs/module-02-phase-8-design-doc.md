# Module 02 Phase 8 Design Doc — GDPR Erasure Workflow + Observability/Hardening

**Status:** Approved for implementation
**Owner:** Org & Employee pod (Module 02)
**Scope:** §2.4/§8 Phase 8 - `ErasureRequest` lifecycle (approve/reject/complete),
the field-by-field anonymization it triggers, `AuditLog` integration, and an
honest observability/hardening pass across everything Module 02 shipped in
Phases 1-7.

## Decision
`ErasureRequestsService`/`ErasureRequestsRepository`/`ErasureRequestResolver`/
`ErasureRequestsController` live inside the existing `EmployeeModule` (not a
new top-level module) - `ErasureRequest` is already that module's entity
(ADR-0011, Phase 1), and the anonymization action is fundamentally a
multi-table write against `Employee`/`EmployeeHistory`, both already owned
there. See ADR-0022 for the field-by-field anonymization rule, the narrow
`employee_history` grant exception, and the one-transaction-or-none write
shape.

## Explicit assumptions
1. **This module's own tables carry very little PII to begin with.** There is
   no name/email/address column anywhere in `org.*` - `EmployeeHistory` is the
   only table that needed a schema-level accommodation (the grant change),
   and even `Employee` itself only has two fields in scope
   (`employee_number`, `user_id`). Anyone expecting "erase the employee's
   name" to be Phase 8 scope will not find it here - that data lives in
   Module 01's `core.users`, out of this module's ownership per §9.
2. **`pending -> approved|rejected`, `approved -> completed|rejected` only** -
   no direct `pending -> completed` shortcut. See ADR-0022.
3. **The audit trail records metadata, not the erased value.** `AuditLog`
   entries for `employee.erasure.completed` never contain the pre-erasure
   `employee_number`.
4. **REST exposes the full lifecycle, not just creation.** §3.2 only spells
   out `POST /v1/employees/{id}/erasure-requests`; `approve`/`reject`/`complete`
   REST routes were added because a create-only surface would leave no way to
   progress a request outside GraphQL.

## Observability/hardening pass (§8's other Phase 8 requirement)
No metrics/tracing backend (Prometheus, OpenTelemetry collector, Grafana,
etc.) exists anywhere in this repository - none was introduced in any prior
phase, and standing one up is an infrastructure decision, not something this
pass can retrofit through code alone. What this pass *does* ship:

- **`docs/module-02-runbook.md`** - operational procedures for every
  background/async process this module runs (nightly skill decay,
  outbox publisher, bulk import, erasure completion), what "healthy" looks
  like for each from the data already in Postgres, and what to check first
  when one misbehaves.
- **A consolidated, honest gap list** (below) of what every phase left
  unfinished, in one place, rather than scattered across seven separate
  per-phase checklists someone would have to read in full to reconstruct.

## Consolidated cross-phase hardening gaps (not fixed in this pass)
These were flagged individually in each phase's own production readiness
checklist; repeating them here is deliberate - a reviewer should not have to
open eight files to learn the whole module has no real authentication yet.

- **No real authentication anywhere in this module.** HTTP (`X-Tenant-Id`/
  `X-Actor-Id`/`X-Platform-Admin` headers, ADR-0014) and gRPC (`tenant_id`
  request field, ADR-0021) both trust client-supplied identity verbatim. This
  is the single largest gap across all eight phases, and it's the one that
  matters most for Phase 8 specifically: nothing stops a caller from
  supplying an arbitrary `X-Actor-Id` and approving/completing an erasure
  request for a tenant they have no real authority over.
- **No RBAC/ABAC.** §2.4's "admin/HR-role only" language for erasure actions
  is not enforced anywhere - any caller who can reach the tenant at all can
  create/approve/reject/complete an erasure request.
- **No load testing** against the §0.5 10M-employee/p99-SLO targets (flagged
  again in Phase 7's checklist for `GetSchedulableEmployees` specifically).
- **No metrics/dashboards backend.** The runbook's "what healthy looks like"
  sections are all direct-SQL-query-based for exactly this reason.
- **No legal sign-off process.** Repeated one final time, as bluntly as
  ADR-0011/ADR-0022 already state it: nothing in this module constitutes a
  completed GDPR compliance program. `legal_basis` is free text specifically
  because validating it is a legal decision, not an engineering one.

## Out of scope for this phase
- `core.users` (Module 01) anonymization.
- Any retention-period override logic (e.g. delaying erasure for an employee
  with an open payroll dispute).
- Authentication/RBAC, load testing, and a metrics backend - all pre-existing
  gaps this phase documents rather than closes (see above).
