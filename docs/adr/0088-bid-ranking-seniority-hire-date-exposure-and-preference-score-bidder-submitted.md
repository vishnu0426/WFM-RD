# ADR-0088: `SchedulableEmployee.hire_date` closes Module 07's seniority-ranking gap; `preference_score` is bidder-submitted, not pulled from another service; single-winner "cutoff" semantics for rank transparency

## Context
§5.1's bid-ranking transparency requires computing a real `rankPosition`/
`rankExplanation` for every bidder across all three `ranking_method`
values. Two of the three needed data this module has no existing source
for:

- **`seniority`**: investigating Module 02's actual capabilities found
  `hire_date` is a real, populated, constraint-checked column on
  `org.employees` (`src/database/migrations/1700000001000-
  Module02OrgEmployeeSchema.ts:303`) - but it was never carried across
  the `EmployeeService.GetSchedulableEmployees` gRPC boundary, because
  nothing had needed it there before. This is not ADR-0076's "zero
  concept anywhere" gap (org-coverage) - the data is real and already
  selected by `EmployeesRepository.findSchedulablePage`'s `getMany()` (a
  full entity, not a partial select) - it's an ADR-0059-shaped gap
  ("real table, no read endpoint yet").
- **`preference_score`**: no entity in this platform (Module 02's
  `Employee`, Module 04's request-scoped `preferred_shift_ids`, or
  anything else) holds a durable, queryable "how much does this employee
  want this specific shift" value. §2.1's own `Bid` DDL has no
  submitted-preference input field either.

## Decision

**Closed the seniority gap** by adding `hire_date` (RFC 3339 date) as
field 6 on `SchedulableEmployee` (`src/grpc/proto/employee.proto`) and
threading it through `EmployeeGrpcController.getSchedulableEmployees`'s
existing response mapping - a two-line change, since the underlying
`Employee` entity already carried the data into that handler. Module 07
gains its own first Module 02 gRPC client
(`EmployeeGrpcClientModule`/`EmployeeGrpcClientService`, this platform's
first Node-to-Node client of `EmployeeService` - every prior consumer is
Python) to call it, scoped by the bid opportunity's own org unit
(`BidService.closeBidOpportunity` fetches the whole org unit's
schedulable roster, then filters client-side to this opportunity's actual
bidders - the same "one org-unit-scoped pull, filter to who you need"
shape `SchedulingEligibilityServicer` already uses for candidate data,
ADR-0082).

Chosen over deferring seniority ranking (ADR-0076's posture) because the
underlying data already exists and the fix is small and low-risk - this
is squarely ADR-0078's precedent (closing a real, small, well-scoped gap)
rather than ADR-0076's (a genuinely absent data model). A bidder whose
hire date this snapshot can't resolve (left the org unit's roster between
bidding and close, a transient gap) is never assigned a fabricated
seniority value - `computeRankings`' `rankBySeniority` sorts them last,
with `yourValue: null` in their own explanation, the same "honestly
flagged, never fabricated" posture ADR-0076/ADR-0059 already established
for other permanent/transient data gaps.

**`preference_score` is bidder-submitted, not pulled from anywhere** -
`submitBid`'s own `preferenceScore` argument (required, and only
meaningful, when the opportunity's `rankingMethod` is `preference_score`;
`PreferenceScoreRequiredError` otherwise), stored verbatim as `Bid.
rankScore` at submission time. This is data only the bidder has (how much
they personally want this specific shift) - inventing a cross-service
pull for it would mean querying a data model that doesn't exist anywhere,
the real ADR-0076 situation, not the ADR-0059 one seniority turned out to
be.

**Single-winner "cutoff" semantics**: every bid's `rankExplanation`
carries `cutoffValue`/`cutoffScore`/`cutoffSubmittedAt` - uniformly the
rank-1 (winning) bid's own value, shown to every bidder regardless of
their own position, matching §5.1's own worked example literally
(`your_position: 6` still sees `cutoff_value: "7 years"` - what it
actually took to win). Consistent with every other post_type in this
module being a 1:1 shift-to-employee mechanism - `BidOpportunity` has no
"how many winners" field, so multi-winner bidding was never in scope to
design around.

## Consequences
- `EmployeeService.GetSchedulableEmployees`'s wire contract gains a field
  - purely additive (proto3 field addition, no renumbering), so every
  existing consumer (scheduling-service's `employee_client.py`) is
  unaffected; `hire_date` is simply absent from their own generated
  message reads until they choose to use it too.
- Module 07 now has two gRPC clients (`SchedulingEligibilityGrpcClientModule`,
  ADR-0086; `EmployeeGrpcClientModule`, this ADR) plus its original gRPC
  server-less posture unchanged - it remains a pure client of both Module
  02 and Module 04, consuming their real contracts rather than
  duplicating either's data model.
- `closeBidOpportunity` only calls `EmployeeGrpcClientService` for
  `seniority` opportunities - `first_come`/`preference_score` never touch
  Module 02 at all, keeping the added client's blast radius scoped to
  exactly the one ranking method that needs it.
- The open-swap/open-shift-claim double-close and duplicate-bid races this
  phase touches are all either prevented by a real DB constraint (`bid_
  opportunity_employee_unique`, unique-violation mapped to `AlreadyBidError`)
  or are self-correcting/idempotent (two concurrent `closeBidOpportunity`
  calls on the same opportunity would compute the same deterministic
  ranking twice, not a different, conflicting one) - no third Redis lock
  was added for bidding; the two `MarketplaceRedisService` call sites
  (claim, open-swap-accept) remain the only ones, both protecting a real
  "exactly one winner, not a deterministic recomputation" race.
