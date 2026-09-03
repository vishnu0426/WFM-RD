# ADR-0016: `Employee` mutation shape - `transferEmployee` owns org/manager changes, `updateEmployee` owns everything else including termination

## Context
§3.1 names `createEmployee`, `updateEmployeeSkills`, and `transferEmployee` as mutations,
but no generic `updateEmployee` and no `terminateEmployee`. §8 Phase 3's own scope line
("Employee CRUD, transfer/terminate flows writing history rows") requires both an update
path and a termination path to exist, so - same situation as ADR-0016's OrgUnit
counterpart in Phase 2 - a gap between the named mutation list and the phase's own
stated scope needs an explicit, documented choice.

## Decision
- **`updateEmployee(id, input)`** covers `employmentType`, `contractHoursPerWeek`,
  `costCenter`, and `status` (including `TERMINATED`) - everything except org/manager
  changes.
- **`transferEmployee(employeeId, newOrgUnitId, newManagerEmployeeId?)`** is the one
  §3.1 actually names, reserved specifically for `orgUnitId`/`managerEmployeeId`
  changes. Kept separate from `updateEmployee` rather than folded in, because §3.1's own
  phrasing ("must write an `EmployeeHistory` row, not just update `org_unit_id` in
  place") treats a transfer as a distinct operation with its own semantics, not an
  incidental field update - and because a future phase adding transfer-specific side
  effects (a notification, a Scheduling cache invalidation per §4's `EmployeeChanged`
  consumer table) has one clear mutation to hang them off, not "some calls to
  `updateEmployee` that happened to touch `orgUnitId`."
- **No `terminateEmployee` mutation.** Termination is `updateEmployee(id, { status:
  TERMINATED })` - the schema already models it as a status/column pair on the same
  `Employee` row (`status`, `terminationDate`), not a separate entity or state machine,
  so a separate mutation would just be a thin, redundant wrapper. If `terminationDate`
  is omitted, `EmployeesService.update` defaults it to today rather than leaving it
  null, since a `TERMINATED` row with no termination date would be inconsistent with
  every query in this module that assumes the two travel together.

`org.fn_employee_history_track` (Phase 1) already versions on any change to
`org_unit_id`, `manager_employee_id`, or `status` unconditionally - both mutations
above satisfy "writes an `EmployeeHistory` row" for free, as a consequence of being
plain column UPDATEs, not because either mutation does anything special.

## Consequences
- `CreateEmployeeInput`/`UpdateEmployeeInput`/`transferEmployee`'s org-unit and
  manager references are validated against `OrgUnitsService`/`EmployeesService`
  before the write (`EmployeesService.create`/`update`/`transfer`) - a bad reference
  surfaces as a clean `OrgUnitNotFoundError`/`EmployeeNotFoundError` (404 / `NOT_FOUND`)
  rather than a raw Postgres foreign-key-violation bubbling up as a 500. The composite
  FKs (ADR-0010) remain the actual enforcement; this is purely a better error shape for
  the common case.
- Self-management (`managerEmployeeId = id`) is not pre-validated at the application
  layer - `employees_not_self_manager` (Phase 1 `CHECK` constraint) is the only guard,
  matching the level of rigor `OrgUnit`'s self-parent case got in Phase 2 (DB-enforced,
  not app-layer-duplicated).
- `employees(filter, pagination)` uses plain offset/limit pagination (`PaginationInput`),
  not cursor-based - §3.1 says "pagination" without specifying a style, and offset/limit
  is the simplest option that satisfies it; revisit if a future phase needs stable
  pagination across concurrent writes.
