# ADR-0086: guardrail validation is a single gRPC call to Module 04's `SchedulingEligibilityService`, not a separate parallel call to Module 02

## Context
§1's tech-stack table describes guardrail validation as "synchronous gRPC
to Module 02 (skill/coverage) and Module 04 (constraint re-check) - the
same calls Module 04's own solver uses," read literally as two separate
calls. Investigating what's actually callable (ADR-0082, ADR-0076) found:
Module 02 has no purpose-built "check this candidate against this
requirement" RPC and no coverage-check capability at all (ADR-0076's
"complete absence of the underlying data model," not a narrow gap); the
new `SchedulingEligibilityService.CheckAssignmentEligibility` RPC
(ADR-0082) *already* pulls Module 02's `EmployeeService.
GetSchedulableEmployees`/`GetEmployeeSkillMatrix` internally (via
scheduling-service's own existing `employee_client.py`, the exact same
client `solve_input_resolver.py` uses mid-solve) and folds any skill
violation into its own unified response - because that's what
`_is_eligible` (the function this RPC reuses verbatim) has always done
inside the solver.

## Decision
Module 07 calls `SchedulingEligibilityService.CheckAssignmentEligibility`
exactly once per guardrail check (`GuardrailValidationService`,
`ClaimOpenShiftService`/`MarketplacePostResolver.eligibleForMe`) - never a
second, separate gRPC client reaching into Module 02's `EmployeeService`
directly. This is not a narrower implementation of §1's instruction; it's
the more literal reading of "the same calls Module 04's own solver uses":
the solver itself never calls Module 02 *and* runs its own separate skill
check - it pulls Module 02's data once and folds it into the same
eligibility decision `_is_eligible` makes. A second, independent Module 07
-> Module 02 call would risk exactly the "parallel implementation" this
module's own non-negotiable (§0) forbids: two different call paths that
could evaluate the same employee's skill match against two different
snapshots of Module 02's data at two different moments, and disagree.

Org-coverage checking specifically remains unavailable, not approximated -
Module 02 has no coverage capability for Module 07 to call any more than
it did for Module 06 (ADR-0076). `EligibilityViolation.category` has no
`org_coverage` value; nothing in this module fabricates one.

## Consequences
- `shift-marketplace-service` has exactly one gRPC client
  (`SchedulingEligibilityGrpcClientService`, pointed at scheduling-service)
  for the whole guardrail-validation surface - no separate client module
  for Module 02's `EmployeeService`, keeping this module's actual gRPC
  footprint smaller than §1's table might suggest on a literal first read.
- If a future need arises for Module 07 to read raw Module 02 data for a
  purpose *other* than eligibility checking (e.g. displaying an employee's
  own skill profile in a marketplace UI), that would be a new, separate
  decision and a new gRPC client - not a reason to revisit this ADR, which
  is scoped specifically to the guardrail-validation path.
- This ADR and ADR-0082 together are the complete answer to §1's guardrail-
  validation row: ADR-0082 is what Module 04 had to build to make a real
  call possible at all; this ADR is why Module 07 makes exactly one call,
  not two, once it exists.
