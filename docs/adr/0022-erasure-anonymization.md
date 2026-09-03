# ADR-0022: Erasure anonymization - field-by-field scope, and a narrow exception to `employee_history`'s append-only grant

## Context
§2.4/§8 require Phase 8 to define, per table, exactly which fields an erasure
anonymizes - "we'll anonymize it" without a field list is explicitly called out
as not a design - and to wire that into `ErasureRequest.status` reaching
`completed`, with the action itself audited via Module 01's `AuditLog`
(metadata only, never the erased PII). ADR-0011 (Phase 1) deliberately shipped
only the request lifecycle; this ADR is the Phase 8 anonymization design ADR-0011
pointed forward to.

## Decision: the field-by-field rule
This module's own schema (`Employee`/`EmployeeHistory`) carries very little PII
to begin with - there is no name/email/address column anywhere in `org.*`; those
live on Module 01's `core.users`, out of this module's ownership (§9: "assume
[Tenant/User/Policy/AuditLog] exist and are stable; do not redefine them here").
Given that, the rule is:

| Table | Field | Action |
|---|---|---|
| `Employee` | `employee_number` | Replaced with a random `ERASED-<8 hex>` placeholder |
| `Employee` | `user_id` | Set to `NULL` - severs the link to the `core.users` identity row |
| `EmployeeHistory` | `employee_number` | Same placeholder, applied to **every** row for that employee, not just the currently-open one |
| `EmployeeSkill` | *(none)* | No PII-bearing column exists on this table - `employee_id` is a stable, already-anonymized-by-then foreign key |
| `ErasureRequest` | *(none)* | The request record itself is the compliance record (ADR-0011) - it is never erased |

Every other column - `org_unit_id`, `employment_type`, `contract_hours_per_week`,
`hire_date`/`termination_date`, `cost_center`, `manager_employee_id`, `status` -
is left untouched. None of it is personal data on its own, and §2.4 requires
*preserving* aggregate/statistical shape for historical reporting, not blanket
deletion; a wiped `hire_date` would break exactly the reporting §2.4 says to keep
working.

**This is a real, load-bearing gap, stated plainly rather than glossed over:**
actual name/email/other-PII erasure for the underlying person is Module 01's
`core.users` responsibility, and nothing in this module's erasure workflow
reaches into `core.users` to perform it (that table isn't this module's to
write - §9). A complete GDPR erasure for a given data subject requires Module
01 to ship its own equivalent workflow against `core.users`; this ADR's scope
is only ever what §2 put in `org.*`.

## Decision: a narrow, additive exception to `employee_history`'s append-only grant
`org.employee_history` is written only by the `fn_employee_history_track`
trigger and is otherwise append-only by design (ADR-0009): the Phase 1
migration grants `agno_app` `UPDATE (valid_to)` only, nothing else. Erasure
needs to overwrite `employee_number` on old, already-closed history rows too -
an append-only table that still leaked the original PII in every prior version
forever would not be an erasure at all.

Rather than widen the grant to full `UPDATE`, or invent a second, ungoverned
write path (e.g. an app-layer bypass using a different role), the Phase 8
migration adds exactly one additional column-scoped grant:
`GRANT UPDATE (employee_number) ON org.employee_history TO agno_app;`. Every
other history column (`org_unit_id`, `status`, `valid_from`, `valid_to`,
...) remains exactly as restricted as before. This is a deliberate, narrow,
documented carve-out in the append-only invariant - not a reversal of it -
and only the erasure code path (`ErasureRequestsRepository.completeAndAnonymize`)
ever exercises it.

## Decision: one transaction, four writes, or none of them
`completeAndAnonymize` scrubs `Employee`/`EmployeeHistory`, flips
`ErasureRequest.status` to `completed`, writes the `AuditLog` entry, and
records the `EmployeeChanged` (`eventType: 'erased'`) outbox event, all inside
a single `withTenantTransaction` call. A completed-but-unaudited erasure (or an
audited erasure that never actually ran) is exactly the kind of half-applied
state this workflow cannot tolerate - see `AuditLogRepository`'s own
transaction-per-call design, which this method deliberately does *not* reuse
(it writes directly via `manager.getRepository(AuditLog).save(...)` inside its
own transaction instead, the same reasoning `OutboxEventsRepository.insertWithinTransaction`
already applies for the outbox write).

## Decision: `AuditLog.beforeState`/`afterState` hold metadata, never the erased value
`beforeState` records `{ erasureRequestId, legalBasis }`; `afterState` records
`{ fieldsAnonymized: ['employeeNumber', 'userId'], historyRowsAnonymized: <count> }`.
Neither ever contains the actual pre-erasure `employee_number`. `AuditLog` is
itself append-only and (per ADR-0007-style platform-admin scoping) readable
cross-tenant by a platform-admin session - logging the real value there would
silently recreate the exact problem the erasure is trying to solve, just one
table over.

## Decision: `pending -> approved|rejected`, `approved -> completed|rejected` only
No `pending -> completed` shortcut. §2.4/§9 both flag that the legal
sufficiency of an erasure request is not an engineering decision; requiring an
explicit `approve` step before the irreversible anonymization runs is the
minimum workflow shape consistent with that. `approveErasureRequest`/
`rejectErasureRequest`/`completeErasureRequest` are three separate
mutations/REST actions, not one generic status setter - the same "explicit
action over generic setter" reasoning ADR-0016 already applied to
`updateEmployee` vs `transferEmployee`.

## Consequences
- No schema/table changes beyond the one grant - `ErasureRequest`'s columns and
  CHECK constraints from Phase 1 (ADR-0011) already fully modeled the lifecycle.
- `EmployeeChangedSubType` gained an `'erased'` member, reusing the existing
  `agno.org.employee.changed.v1` subject rather than minting a new one -
  Scheduling/Forecasting already consume that subject to invalidate cached
  results per org unit (§4), and an erased employee needs exactly that same
  invalidation.
- Explicitly out of scope, again: legal sufficiency of any given erasure
  request, `core.users` (Module 01) anonymization, and any retention-period
  logic that might legally require *delaying* an erasure (e.g. open payroll
  disputes) - none of that is modeled here.
