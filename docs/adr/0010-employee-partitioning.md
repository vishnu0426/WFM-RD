# ADR-0010: `Employee`/`EmployeeHistory`/`EmployeeSkill` - `PARTITION BY HASH (tenant_id)`, 8-way

## Context
§0.5's capacity-planning line item states 10M+ employee records platform-wide and
requires partitioning "by tenant_id or tenant_id + org_unit_id... from day one, not
retrofitted at 1M rows." `EmployeeSkill` multiplies that further (multiple skills
per employee). `EmployeeHistory` grows with every tracked-field mutation on top of
that. All three need a partitioning strategy chosen now, the same way `AuditLog`'s
`PARTITION BY RANGE (created_at)` was chosen in Module 01 (ADR-0005).

## Options considered
1. **RANGE by tenant_id** (or LIST, one partition per tenant/tenant tier). Natural
   fit if a handful of "whale" tenants dominate row counts, but this platform's
   tenant distribution (§1: SMB/enterprise/BPO tiers, no single named mega-tenant)
   doesn't support that assumption, and LIST-per-tenant doesn't scale to a growing
   tenant count without a migration adding a new partition per new tenant.
2. **RANGE by tenant_id + org_unit_id composite.** Rejected: doesn't change the
   fundamental partition-count-tracks-tenant-count problem, and adds a second
   dimension of complexity (`org_unit_id` isn't stable pre-creation the way a
   monotonic range key is) for no corresponding benefit at this table's actual
   query pattern (almost every query is already tenant-scoped by RLS; sub-tenant
   partition pruning by org unit isn't the bottleneck).
3. **HASH by tenant_id, fixed modulus** (chosen). Spreads all tenants' rows evenly
   across a fixed number of partitions regardless of tenant count or size skew, with
   every partition created upfront - no rolling partition-creation job is needed the
   way `AuditLog`'s monthly RANGE partitions need `pg_partman` (Module 01's
   production-readiness checklist flags this explicitly as unowned ops work).

## Decision
`org.employees`, `org.employee_history`, and `org.employee_skills` are each
`PARTITION BY HASH (tenant_id)` with a fixed modulus of 8, all 8 partitions created
in the Phase 1 migration (no bootstrap-then-rotate step, unlike `AuditLog`).
`employee_history` and `employee_skills` use the *same* modulus so that a given
tenant's rows across all three tables land on correspondingly-numbered partitions,
enabling partition-wise joins for tenant-scoped queries that span them.

Postgres requires the partition key in every unique index/PK on a partitioned
table, so `Employee`/`EmployeeHistory`'s PK becomes composite `(tenant_id, id)`
rather than a bare `id` - the same consequence `AuditLog`'s RANGE partitioning had
on its own PK (ADR-0005), just from a different partitioning strategy. `id` stays
practically-unique via UUIDv4 generation; it just isn't DB-enforced globally unique
across partitions the way a single-table PK would be.

## Consequences
- No partition-rotation ops burden (unlike `AuditLog`) - modulus 8 covers the full
  key space immediately. The trade-off: growing beyond what 8 partitions can serve
  well requires a partition-split migration (rehashing into a higher modulus), not
  "add one more partition" - a real operational event, flagged in the production
  readiness checklist as future work once real row-count data justifies it.
- Every composite FK touching these tables carries `tenant_id` explicitly
  (`fk_employees_tenant_org_unit`, `fk_employees_tenant_manager`,
  `fk_employees_tenant_user`, `fk_employee_skills_tenant_employee`,
  `fk_employee_skills_tenant_skill`) - both because the partition key must appear in
  what it references, and because it means these FKs enforce cross-entity tenant
  consistency for free (an `Employee` can never reference an `OrgUnit`/manager/`User`
  belonging to a different tenant), matching the composite-FK half of Module 01's
  ADR-0004 rather than a trigger-synced column.
- `EmployeesRepository.create()` generates `id` client-side (`uuidv4()`) rather than
  relying on the column's DB default via Postgres `RETURNING`, for the same
  determinism reason `AuditLogRepository.record()` does in Module 01 - doubly
  relevant here since the PK is composite.
