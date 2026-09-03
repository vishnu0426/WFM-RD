# Module 02 Phase 3 Design Doc — Employee Profiles + History

**Status:** Approved for implementation
**Owner:** Org & Employee pod (Module 02)
**Scope:** §8 Phase 3 — Employee CRUD, transfer/terminate flows writing history
rows, manager-hierarchy queries. Builds on Phase 1's `Employee`/`EmployeeHistory`
schema and Phase 2's GraphQL/REST infrastructure (`TenantContextMiddleware`,
`DomainErrorFilter`/`formatGraphQLError`, `OrgApiModule` composition pattern).

## Decision

GraphQL-only (§1's REST-for-bulk/integration framing already established in Phase 2 -
§3.2 names no plain-CRUD REST route for employees, only `GET /v1/employees/{id}/skills`,
which is Phase 4's concern). `EmployeesService` mirrors `OrgUnitsService`'s shape from
Phase 2: a thin layer over `EmployeesRepository` that turns bad references into clean
`DomainError`s before they hit the database. `EmployeeResolver` moved from a
field-resolver-only class (Phase 2, just `orgUnit`/`manager` for `OrgUnit.employees`)
to a full resolver with top-level queries/mutations - still registered in `OrgApiModule`
for the same cross-module reason as before (§ ADR discussion in `OrgApiModule`'s doc
comment).

## Explicit assumptions

1. **Mutation shape** (`updateEmployee` + `transferEmployee`, no `terminateEmployee`).
   See ADR-0016.
2. **`employeeHistory(employeeId)` query added**, not explicitly named by §3.1's query
   list but a direct extension of §2.3's own stated motivation ("backdated payroll
   disputes") to the entity §2.3 names alongside `OrgUnit` - `EmployeeHistory` already
   exists and is queryable (Phase 1); leaving it with no read surface at all would be
   an odd asymmetry with `OrgUnitHistory`'s Phase 2 exposure.
3. **`Employee.directReports` field added** (not in §3.1's literal field list) -
   "manager-hierarchy queries" is explicit Phase 3 scope text, and `manager` alone
   only walks the hierarchy upward; `directReports` is the other half, backed by the
   same `EmployeesRepository.findDirectReports` Phase 1 already built.
4. **ABAC still not implemented** - `employees(filter, pagination)` is tenant-scoped
   only, same gap ADR-0014 already recorded for `orgHierarchy`.

## Out of scope for this phase

- `Skill`/`EmployeeSkill` GraphQL surface, `updateEmployeeSkills` mutation, `GET
  /v1/employees/{id}/skills` (Phase 4).
- Bulk employee import (Phase 6).
- `EmployeeChanged` NATS events on create/update/transfer (Phase 6) - the schema/
  trigger side (`EmployeeHistory` versioning) is done; nothing publishes yet.
