# Module 02 Phase 4 Production Readiness Checklist

Extends the Phase 1-3 checklists rather than restating them.

## Delivered in this phase

- [x] GraphQL: `skill(id)`, `skillsExpiringSoon(withinDays)` queries; `createSkill`,
      `updateEmployeeSkills` mutations; `Employee.skills` field (closing the
      ADR-0015 gap); `EmployeeSkill.skill` field resolver.
- [x] REST: `GET /v1/employees/{id}/skills`, `GET /v1/skills/expiring` (paginated).
- [x] Nightly decay job: checkpointed, resumable, idempotent per tenant
      (`org.decay_job_runs`), bulk-SQL decay recompute, tenant-local-time
      scheduling via `WorkingTimeCalendar.timezone` (ADR-0017).
- [x] Certification-expiry detection with real `NotificationPreference`-based
      recipient resolution (logged, not dispatched - see ADR-0017).
- [x] `PolicyType.SKILL_DECAY_HALF_LIFE` extends `core.policies` for the
      tenant-configurable half-life.

## Explicitly NOT done here

- [ ] **Real notification delivery.** Nothing in this repo sends an email/SMS/push
      anywhere - this phase only gets the "who/what" right and logs it.
- [ ] **`SkillExpiring` NATS event.** Phase 6.
- [ ] **Per-tenant-configurable decay-job run window.** Fixed at local 02:00
      (ADR-0017) - real configurability needs a new schema field this phase didn't
      build.
- [ ] **Metrics/paging on job overrun or failure** (§5's own observability
      requirement). Only `Logger` output exists - no Prometheus/equivalent metrics,
      no on-call paging integration.
- [ ] **Load-tested decay job at 10M-employee/100k-batch scale** (§0.5). The
      batch/checkpoint design targets that scale (ADR-0010/ADR-0017's reasoning);
      it has not been run against real volume.
- [ ] **GraphQL query complexity limiting** on `Employee.skills`/`OrgUnit.employees`
      combined traversal - same standing gap noted in the Phase 2 checklist,
      compounded by one more resolver.
