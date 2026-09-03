# Module 02 Phase 8 Production Readiness Checklist

Extends the Phase 1-7 checklists. This is also the **final** phase of the
Module 02 spec - see the bottom of this file for a full Phase 1-8 rollup.

## Delivered in this phase

- [x] `ErasureRequest` lifecycle: `createErasureRequest` (GraphQL) /
      `POST /v1/employees/:id/erasure-requests` (REST), `approve`/`reject`/
      `complete` as explicit mutations/REST actions (not a generic status
      setter - ADR-0022).
- [x] Field-by-field anonymization rule, stated explicitly per table
      (ADR-0022): `Employee.employee_number` -> `ERASED-<hex>`,
      `Employee.user_id` -> `NULL`, every `EmployeeHistory.employee_number`
      row for that employee -> same placeholder. Everything else untouched.
- [x] Narrow, additive `GRANT UPDATE (employee_number) ON org.employee_history`
      - the one deliberate, documented exception to that table's append-only
      grant (ADR-0009/ADR-0022).
- [x] `AuditLog` integration: one `employee.erasure.completed` entry per
      completion, metadata-only (`fieldsAnonymized`, `historyRowsAnonymized`)
      - never the erased value itself.
- [x] Outbox event (`agno.org.employee.changed.v1`, `eventType: 'erased'`) on
      completion, reusing the existing `EmployeeChanged` subject/consumer
      contract rather than minting a new one.
- [x] One transaction for the entity scrub + status flip + audit write +
      outbox write - verified via integration test that a request cannot be
      completed twice and that a too-early `complete` (before `approve`) is
      rejected with `INVALID_STATE_TRANSITION` (HTTP 409 / GraphQL
      `extensions.code`).
- [x] Integration test (`test/integration/erasure-workflow.spec.ts`) against
      the real Postgres instance: verifies the live row, **every** history
      row (including a closed one from a prior transfer), the audit log
      entry, and the outbox event, all directly via SQL/repository reads -
      not just the API response shape.
- [x] `docs/module-02-runbook.md` - operational runbook for every
      background/async process across all eight phases.

## Explicitly NOT done here

- [ ] **No authentication/RBAC gate on who can approve/complete an erasure
      request.** §2.4 says "admin/HR-role only"; nothing enforces that - see
      the Phase 8 design doc's consolidated gap list.
- [ ] **No `core.users` (Module 01) anonymization.** This module's erasure
      workflow only ever touches `org.*` tables it owns - actual name/email
      erasure for the person is a separate, unbuilt Module 01 workflow.
- [ ] **No retention-period override.** An employee with e.g. an open payroll
      dispute or legally-mandated record retention has no mechanism here to
      delay or block an approved erasure - `approve` -> `complete` always
      succeeds once both steps are taken.
- [ ] **No real metrics/dashboards backend.** The runbook's health checks are
      direct SQL, not a Grafana board - no such backend exists anywhere in
      this repository as of any phase.
- [ ] **Legal sign-off has not happened and this checklist cannot substitute
      for it** (ADR-0011, restated here one final time per §2.4/§9).

## Module 02 (Phases 1-8) rollup

All eight phases from the coding prompt are implemented, migrated, and
integration-tested against the real Postgres instance:

1. Schema & migrations - `org` schema, SCD Type 2 history triggers, `ltree`
   hierarchy, HASH partitioning, RLS, two-role grant model.
2. Org structure + temporal (as-of) queries - GraphQL/REST.
3. Employee profiles + history - CRUD, transfer/terminate, manager hierarchy.
4. Skills & competency - decay job, certification alerts.
5. Calendars & employment policy - wired into the existing `PolicyService`
   pattern (`core.policies`, extended).
6. Bulk HRIS integration - async job, dry-run, feature-flagged rollout, NATS
   JetStream transactional outbox (Kafka intentionally overridden per §1).
7. gRPC surface for Scheduling/Forecasting - streaming
   `GetSchedulableEmployees`, `GetEmployeeSkillMatrix`, `GetWorkingTimeRules`.
8. GDPR erasure workflow + this consolidated observability/hardening pass.

**Standing, cross-cutting gaps that persist across all eight phases** (not
regressions - present since Phase 1/2 and never closed, restated here so
they're visible in one place): no real authentication (ADR-0014/ADR-0021
placeholder posture), no RBAC/ABAC, no load testing against the §0.5 10M-row/
p99 targets, no metrics/dashboards backend, and no legal sign-off on the
erasure workflow. Closing these is follow-on work, explicitly not silently
assumed done by anything in this rollup.
