# Module 02 Phase 5 Design Doc — Calendars & Employment Policy

**Status:** Approved for implementation
**Owner:** Org & Employee pod (Module 02)
**Scope:** §8 Phase 5 — `WorkingTimeCalendar` surface, `EmploymentPolicy` wired into
the `PoliciesRepository.findActiveAsOf`-style pattern (ADR-0006/ADR-0012). Pure API
layer on top of Phase 1's already-complete schema - no new migration.

## Decision

`WorkingTimeCalendarsService.upsert` implements §3.2's "create/update" `POST
/v1/calendars` as one keyed upsert (`orgUnitId`, `null` = tenant default), matching
the DB's own partial-unique-index model from Phase 1 rather than inventing separate
create/update endpoints REST doesn't ask for. `EmploymentPoliciesService.create`
implements §3.1's `createEmploymentPolicy` as either "start a lineage" or "add a
version," keyed by an optional `policyGroupId` (ADR-0018).

Both new modules' cross-module validation needs (`orgUnitId` existence) required
`CalendarModule` and `PolicyModule` to import `OrgUnitModule` - the latter is an
unusual direction for a nominally Module 01 module, but a direct continuation of
ADR-0012's decision to keep `EmploymentPolicy` inside `core.policies`/`PolicyModule`.

## Explicit assumptions

1. **`EmploymentPolicyType` is a narrower enum than `PolicyType`**, restricting
   `createEmploymentPolicy` to the four employment-scoped types. See ADR-0018.
2. **`WorkingTimeCalendar.timezone` is not validated against the IANA zone
   database** at input time - `SkillDecaySchedulerService` (Phase 4) already
   tolerates and logs an unrecognized zone, falling back to UTC, so this phase
   doesn't duplicate that validation.
3. **No GraphQL mutation for `WorkingTimeCalendar`** - §3.1 names none, and §3.2's
   `POST /v1/calendars` is the one surface actually specified. A `workingTimeCalendar(orgUnitId)`
   GraphQL *query* was added for read access (there's no other way to read a
   calendar back otherwise), mirroring the read/write REST/GraphQL split already
   established for `OrgUnit`'s tree endpoint in Phase 2.

## Out of scope for this phase

- Bulk HRIS import, NATS eventing, gRPC contracts (Phases 6-7).
- GDPR erasure workflow (Phase 8).
