# Module 02 Phase 1 Production Readiness Checklist

Honest split between what this phase's code actually delivers and what is
genuinely infrastructure/process/later-phase work (§0.5), extending Module 01's
`docs/production-readiness-checklist.md` rather than restating it.

## Delivered in this phase (application code)

- [x] Full DDL for every §2 entity (`OrgUnit`, `OrgUnitHistory`, `Employee`,
      `EmployeeHistory`, `Skill`, `EmployeeSkill`, `WorkingTimeCalendar`,
      `ErasureRequest`), plus the additive `core.policies` extension backing
      `EmploymentPolicy` (ADR-0012), all with `up`/`down` migrations.
- [x] Row Level Security on every tenant-scoped `org.*` table, same
      `tenant_id = current_setting(...)` shape as `core.*` - verified by the same
      `npm run migration:lint` CI gate, extended to cover both schemas.
- [x] `Employee`/`EmployeeHistory`/`EmployeeSkill` partitioned
      `PARTITION BY HASH (tenant_id)`, 8-way, all partitions created upfront
      (ADR-0010) - no `AuditLog`-style rotation job needed for this strategy.
- [x] SCD Type 2 history for `OrgUnit`/`Employee`, entirely DB-trigger-written,
      append-only at the GRANT level (`INSERT` + column-scoped `UPDATE (valid_to)`
      only, no `DELETE`) - ADR-0009.
- [x] Materialized-path (`ltree`, GiST-indexed) subtree reads for `OrgUnit`,
      trigger-maintained on insert/reparent, including cycle rejection
      (reparenting under self or a descendant) - ADR-0008.
- [x] `EmployeeSkill.expiryDate` derived by trigger from
      `Skill.certificationValidityDays` - never set directly by application code.
- [x] `ErasureRequest` schema + lifecycle repository (ADR-0011) - request
      creation/lookup only, no anonymization logic (Phase 8).
- [x] `EmploymentPolicy` implemented as an additive, backward-compatible
      extension of Module 01's `core.policies` (ADR-0012), not a parallel table.
- [x] Composite FKs enforcing cross-entity tenant consistency
      (`Employee.orgUnitId`/`managerEmployeeId`/`userId`, `EmployeeSkill.skillId`)
      - a mismatched-tenant reference is a DB-level FK violation, not an
      application-layer check that could be forgotten.
- [x] Seed script extended with a 3-level `OrgUnit` tree, two employees (one with
      login access via `userId`, one headcount-only per §2.2 rule 2), a certified
      skill, a tenant-default `WorkingTimeCalendar`, and an org-unit-scoped
      `EmploymentPolicy`.
- [x] Integration test (`test/integration/org-rls-isolation.spec.ts`) covering
      cross-tenant RLS isolation on the new tables, ltree subtree containment,
      history-trigger versioning + append-only enforcement, and the
      `EmploymentPolicy` extension.

## Explicitly NOT done here (needs a different owner, or a later phase, before go-live)

- [ ] **Cross-module migration sign-off.** This phase's migration alters
      `core.policies`, a Module 01-owned table (ADR-0012). The change is additive
      and backward compatible, but in a real multi-team org this still needs
      explicit sign-off from whoever owns Module 01's schema before merging -
      not silently assumed by this repo alone.
- [ ] **Terraform/Vault/PITR/read-replica provisioning.** Same gap Module 01
      flagged; nothing here changes it. `docker-compose.yml` remains local-dev only.
- [ ] **A partition-count-growth plan for the HASH-partitioned tables.** Modulus 8
      is a fixed, documented placeholder (ADR-0010); growing past what it serves
      well requires a partition-split migration, which is a real operational
      event with no owner assigned yet.
- [ ] **The nightly decay/certification-alert job** (§5, Phase 4).
      `EmployeeSkill.decayScore` has its `[0,1]` CHECK and a `1` default; nothing
      recomputes it on a schedule yet, and no `SkillExpiring` event exists yet.
- [ ] **NATS JetStream outbox for `EmployeeChanged`/`SkillExpiring`** (Phase 6) -
      no eventing exists in this phase at all.
- [ ] **The GDPR erasure anonymization workflow** (Phase 8, ADR-0011). Creating an
      `ErasureRequest` today has zero effect on any employee data. The
      field-by-field anonymization rules, the trigger/service that executes them,
      and the `AuditLog` integration are all unbuilt.
- [ ] **Legal sufficiency of the erasure workflow.** Explicit non-goal per §2.4/§9
      - this phase (and Phase 8, once built) implements a mechanism; it does not
      constitute legal GDPR compliance certification.
- [ ] **Load testing at the stated 10M-employee / 100k+ RPS platform-wide
      targets.** The partitioning and index strategy (ADR-0010, ADR-0008) are
      designed against those targets but not empirically validated against them -
      same gap Module 01 flagged for its own capacity targets, inherited here.
- [ ] **`GetSchedulableEmployees`/`GetEmployeeSkillMatrix`/`GetWorkingTimeRules`
      gRPC contracts** (§3.3, Phase 7) - the data these will serve exists; the
      contracts and streaming-for-large-org-units behavior do not yet.
