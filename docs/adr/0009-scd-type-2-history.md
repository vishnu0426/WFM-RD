# ADR-0009: `OrgUnitHistory`/`EmployeeHistory` as two typed SCD Type 2 tables, trigger-written

## Context
§2.3 explicitly flags temporal/versioned org and employee history as needing
explicit design now, not a later retrofit, and poses two open trade-offs:
(a) two dedicated history tables vs. one generic `temporal_snapshot` pattern, and
(b) a DB trigger vs. an application-layer transactional write for versioning.

## Decision

**Two typed tables, not one generic polymorphic table.** `OrgUnitHistory` and
`EmployeeHistory` each mirror their live table's tracked columns directly (typed
columns, not a `jsonb` blob of "whatever the row looked like"). A generic
`temporal_snapshot(entity_type, entity_id, valid_from, valid_to, snapshot jsonb)`
table was rejected: reconstructing "what was `Employee.managerEmployeeId` on
March 1st across every backdated payroll dispute" against a `jsonb` blob needs
either an expression index per queried field (one per entity type, so the
"generic" table stops being generic in practice) or an `EXISTS`/`->>'field'` scan
that can't use a plain btree the way a typed column can. Compliance/audit queries
(§2.3's stated motivation) are exactly the query shape typed columns serve well and
`jsonb` blobs serve poorly.

**DB trigger, not an application-layer transactional write.** `org.fn_org_unit_history_track`
and `org.fn_employee_history_track` (Phase 1 migration) fire on every `INSERT` and on
any `UPDATE` that changes a tracked column, closing the prior open row
(`valid_to = now()`) and inserting a new one - both writes happen inside the same
statement's trigger execution, so there is no window where a bug in application code
(a missed call, an exception after the main `UPDATE` but before a history write,
a direct SQL escape hatch) can update `OrgUnit`/`Employee` without a corresponding
history row. The trade-off named in §2.3 - "trigger = can't be bypassed by a bug in
application code; app-layer = easier to unit test and keep business-logic-aware" -
is resolved in favor of the former: this data feeds banking/government compliance
audits and backdated payroll disputes (§2.3's own stated motivation), where a
silent gap in the history is a worse failure mode than the reduced unit-testability
of trigger logic (covered instead by the integration test suite, which runs
against real Postgres).

## Consequences
- `agno_app` gets `SELECT, INSERT` plus a **column-scoped** `UPDATE (valid_to)`
  grant on both history tables, and no `DELETE` grant at all - the same
  defense-in-depth posture as `core.audit_log`'s full UPDATE/DELETE revoke
  (§2.2 rule 2 precedent), just slightly looser because the "close the prior
  version" step is itself a legitimate, expected write. The full historical
  row state (`before_state`, the actual field values at that version) can never
  be altered post-insert - only the closing timestamp can.
- Both history repositories (`OrgUnitHistoryRepository`, `EmployeeHistoryRepository`)
  expose no `create`/`update`/`delete` methods - matching the grants, and matching
  `AuditLogRepository`'s posture from Module 01.
- `orgHierarchy(rootId, asOfDate)` (Phase 2) reconstructs a past tree by walking
  `OrgUnitHistory.parentOrgUnitId` via a recursive CTE over rows valid at that
  timestamp - see ADR-0008 for why this deliberately doesn't reuse the live
  table's `path` column.
- Versioning triggers only fire on changes to the columns §2.3 names explicitly
  (`OrgUnit`: `parent_org_unit_id`, `type`, `name`, `timezone`, `country_code`,
  `status`; `Employee`: `org_unit_id`, `manager_employee_id`, `status`) - an
  `updated_at`-only touch, or an `Employee.costCenter` change, does not open a new
  version. If finer-grained tracking is needed later, it's an additive change to
  the trigger function's `IF` condition, not a schema migration.
