# Module 02 Phase 4 Design Doc — Skills & Competency + Decay Job

**Status:** Approved for implementation
**Owner:** Org & Employee pod (Module 02)
**Scope:** §8 Phase 4 — `Skill`/`EmployeeSkill` GraphQL/REST surface, the nightly
decay job (§5) with resumability, certification-expiry alerting via Module 01's
`NotificationPreference`. Builds on Phase 1's schema (`Skill`, `EmployeeSkill`,
their triggers) and Phases 2-3's GraphQL/REST/service patterns.

## Decision

`SkillModule` grows from a data-only module (Phase 1) into a full GraphQL/REST/batch-job
module - `SkillsService`/`EmployeeSkillsService` (mirroring `OrgUnitsService`/
`EmployeesService`'s shape), `SkillResolver`/`EmployeeSkillsFieldResolver` (GraphQL),
`SkillsController` (REST), and `SkillDecayJobService`/`SkillDecaySchedulerService`
(the batch job, ADR-0017). Unlike `OrgUnitResolver`/`EmployeeResolver`, the field
resolvers this phase adds to the *existing* `Employee` GraphQL type
(`EmployeeSkillsFieldResolver`, contributing `Employee.skills`) live in `SkillModule`
itself rather than `OrgApiModule` - NestJS's code-first schema builder merges
`@Resolver(() => X)` contributions into type `X`'s schema regardless of which module
registers the resolver class, so this closes the `skills` field gap ADR-0015 left
without needing `SkillModule` and `EmployeeModule` to import each other.

## Explicit assumptions

1. **`WorkingTimeCalendar.timezone` added, additively.** §5 assumes it exists; §2.1's
   field list never named it. See the migration's own comment and ADR-0017.
2. **`createSkill` mutation added** - §3.1 names no skill-catalog-management mutation
   at all, and without one the catalog `EmployeeSkill`/`updateEmployeeSkills` depend on
   has no API path to populate, same gap-filling precedent as Phase 2/3's added
   mutations.
3. **Decay job scheduling is fixed at tenant-local 02:00, not itself tenant-configurable.**
   See ADR-0017.
4. **Certification alerts are logged, not dispatched.** See ADR-0017 - no notification
   delivery mechanism exists anywhere in this repo yet.
5. **`GET /v1/employees/{id}/skills` returns the current skill set**, not a temporal
   history - `EmployeeSkill` has no SCD history table (unlike `OrgUnit`/`Employee`),
   and §3.2's "full skill/certification history" reads naturally as "the complete
   current list," not an implied new history table §2.1 never asked for.
6. **ABAC still not implemented** - same standing gap as every prior phase (ADR-0014).

## Out of scope for this phase

- `WorkingTimeCalendar`/`EmploymentPolicy` GraphQL/REST surface (Phase 5).
- Actual `SkillExpiring` NATS publishing (Phase 6).
- Real notification delivery (no owner anywhere in this repo yet).
- gRPC `GetEmployeeSkillMatrix` (Phase 7) - reads `decayScore` this phase computes,
  but the contract itself isn't built yet.
