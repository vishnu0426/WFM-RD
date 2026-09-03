# ADR-0076: `conflict_flags.orgCoverage` is permanently `null` until Module 02 exposes an org-coverage capability

## Context
§4.4 specifies two synchronous conflict checks at `requestLeave` time: a
schedule-conflict check against Module 04, and an "org coverage" check
against Module 02 - implicitly, something like "would approving this leave
request drop staffing below a minimum threshold for the employee's org
unit during the requested dates." §1's tech-stack table mandates gRPC for
both directions.

Before building a client for the Module02 side, every `.proto` Module 02
(core `src/grpc/proto/`) exposes was read in full:
`employee.proto` (`GetSchedulableEmployees`, `GetEmployeeSkillMatrix`),
`calendar.proto` (`GetWorkingTimeRules` - holidays/business hours only),
`policy.proto`, `identity.proto`, `audit.proto`. None of them, and no table
in Module 02's own schema, carries any concept of "minimum coverage,"
"staffing threshold," or a per-org-unit headcount target. This is not a
narrow gap in an otherwise-adjacent endpoint (the way Module 04's leave
data was a real table with no read endpoint yet, ADR-0059) - it is the
complete absence of the underlying data model. Nothing exists to build a
client *against*.

This mirrors, structurally, the exact gap ADR-0059 documented for Module
04's leave/unavailability data before this module existed - "no real
source exists anywhere in the platform... permanently, until Module 06
ships." The honest, correctly-scoped answer here is the same one that ADR
modeled: name the gap precisely, do not fabricate a result to fill it, and
say what closing it actually requires.

## Decision
`LeaveConflictCheckService.check()` populates `conflictFlags.scheduleConflict`
for real (Module 04, via `ScheduleServiceClient`, REST per Phase 1's own
explicit assumption). `conflictFlags.orgCoverage` is **always `null`** -
explicitly "not evaluated," never coerced to `false`/"no conflict" (which
would be a fabricated, silently-wrong signal a supervisor could rely on)
and never coerced to `true`/"always flag" (which would make every
submission look staffing-risky regardless of reality, training reviewers
to ignore the flag). No gRPC or REST call to Module 02 is attempted for
this check - there is no endpoint to call.

§2.2 rule 2's "fail closed on a conflict-check failure, don't submit
without a check" applies to a call that exists and can fail transiently
(Module 04's, or a future Module 02 endpoint's) - it does not mean
"invent a call that always errors" for a capability that was never built.
Treating an absent capability as a permanent failure would make every
`requestLeave` call permanently reject, which is a worse outcome than
being honest that this half of the check doesn't exist yet.

## Consequences
- A supervisor reviewing `conflict_flags` in any later phase's UI/GraphQL
  surface sees `orgCoverage: null` and must understand that as "not
  evaluated," not "confirmed fine" - whichever phase builds that UI must
  render this state distinctly (e.g. "coverage not checked"), not silently
  treat `null` the same as a real `false`.
- Closing this gap is real, separately-scoped work belonging to Module 02,
  not Module 06: a coverage/minimum-staffing data model (what "coverage"
  even means - per org unit? per skill? per shift template?), a migration,
  and a new gRPC service exposing it, plus - given Module 02 already runs
  a real gRPC server, unlike Module 04 - this would be the platform's
  first genuine same-language (Node-to-Node) gRPC client, a new precedent
  Module 06 would then adopt for this one call only.
- Until that exists, this module's own production readiness checklist
  (Phase 3) lists org-coverage evaluation as explicitly not done, the same
  honesty standard `scheduling-service`'s own Phase 6 checklist applied to
  the leave-data gap this ADR mirrors.
- If a future phase decides org coverage should block submission outright
  (not just flag it) once the capability exists, that is a new decision
  requiring its own ADR - this one only commits to "don't fabricate a
  result," not to any particular enforcement posture once real data
  exists.
