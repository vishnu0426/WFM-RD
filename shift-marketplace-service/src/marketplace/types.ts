import { Field, ID, ObjectType } from '@nestjs/graphql';

/** §2.1/§3.1 - co-located with the domain, same convention as intraday-service's own `src/alerting/types.ts`. */
@ObjectType('MarketplacePost')
export class MarketplacePostResult {
  @Field(() => ID)
  id!: string;

  @Field(() => String)
  postType!: string;

  @Field(() => ID)
  shiftAssignmentId!: string;

  @Field(() => ID)
  orgUnitId!: string;

  @Field(() => String)
  status!: string;

  @Field(() => Date)
  expiresAt!: Date;

  /**
   * §3.1: resolved server-side (`MarketplacePostResolver.eligibleForMe`,
   * a `@ResolveField`) against the querying employee's actual eligibility -
   * never a client-side filter, and never precomputed here, since it
   * depends on *who's asking*.
   */
  @Field(() => Boolean)
  eligibleForMe!: boolean;

  /**
   * Shift Marketplace Manager View phase, §4 of the frontend prompt: the
   * bid-results transparency page needs a way to get from a `BID`-type post
   * to its `BidOpportunity` - no such lookup existed before this phase.
   * Null for `open_shift`/`swap` posts, and for a `bid` post whose
   * opportunity hasn't been created yet. Resolved server-side
   * (`MarketplacePostResolver.bidOpportunityId`, a `@ResolveField`), same
   * "never precomputed here" posture as `eligibleForMe`.
   */
  @Field(() => ID, { nullable: true })
  bidOpportunityId!: string | null;
}

@ObjectType('EligibilityViolation')
export class EligibilityViolationResult {
  @Field(() => String)
  category!: string;

  @Field(() => String)
  detail!: string;
}

@ObjectType('MarketplaceClaim')
export class MarketplaceClaimResult {
  @Field(() => ID)
  id!: string;

  /**
   * Shift Marketplace Manager View phase, §2: the approval queue needs to
   * show which employee is claiming - not exposed before this phase since
   * every prior consumer (`claimOpenShift`'s own response) already knows
   * who they are (it's the caller's own action).
   */
  @Field(() => ID)
  claimantEmployeeId!: string;

  @Field(() => String)
  status!: string;

  /** ADR-0159: `open_shift_claim` (`claimOpenShift`) or `bid` (a closed `BidOpportunity`'s winner). */
  @Field(() => String)
  source!: string;

  // `@Field(() => Object)`, matching `JsonScalar`'s own `@Scalar('JSON', () =>
  // Object)` registration (`../graphql/json.scalar.ts`) - same binding
  // intraday-service's `ReallocationAction.aiRationale` uses, not
  // `@Field(() => JsonScalar)` (the scalar class itself is never the field's
  // own type-function target).
  @Field(() => Object, { nullable: true })
  validationResult!: Record<string, unknown> | null;

  @Field(() => Date)
  claimedAt!: Date;

  /** Shift Marketplace Manager View phase, §2 - set only on a rejection. */
  @Field(() => String, { nullable: true })
  decisionReason!: string | null;
}

@ObjectType('ClaimOpenShiftResult')
export class ClaimOpenShiftResultType {
  @Field(() => MarketplaceClaimResult)
  claim!: MarketplaceClaimResult;

  @Field(() => MarketplacePostResult)
  post!: MarketplacePostResult;
}

/** §2.1/§3.1/ADR-0087 - the `initiator`/`initiatorShift`/`targetEmployee` fields §3.1 describes are IDs here, same cross-module-reference-as-plain-id convention as `MarketplacePost`. */
@ObjectType('SwapRequest')
export class SwapRequestResult {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  initiatorEmployeeId!: string;

  @Field(() => ID)
  initiatorShiftId!: string;

  @Field(() => ID, { nullable: true })
  targetEmployeeId!: string | null;

  @Field(() => ID, { nullable: true })
  targetShiftId!: string | null;

  @Field(() => String)
  status!: string;

  @Field(() => Boolean)
  requiresSupervisorApproval!: boolean;

  @Field(() => Object, { nullable: true })
  validationResult!: Record<string, unknown> | null;

  @Field(() => Date)
  createdAt!: Date;

  /** Shift Marketplace Manager View phase, §2 - set only on a rejection. */
  @Field(() => String, { nullable: true })
  decisionReason!: string | null;
}

/**
 * Shift Marketplace Manager View phase, §2: `pendingMarketplaceActions`'s
 * per-row shape - exactly one of `claim`/`swap` is populated, same
 * not-a-union convention `ApproveMarketplaceActionResultType` already
 * established. `claimPost` is the shift/post context a claim row needs
 * (§2's own "shift detail" requirement) - a `SwapRequest` needs no
 * equivalent since it already carries both shifts' ids directly.
 */
@ObjectType('PendingMarketplaceAction')
export class PendingMarketplaceActionResult {
  @Field(() => MarketplaceClaimResult, { nullable: true })
  claim!: MarketplaceClaimResult | null;

  @Field(() => MarketplacePostResult, { nullable: true })
  claimPost!: MarketplacePostResult | null;

  @Field(() => SwapRequestResult, { nullable: true })
  swap!: SwapRequestResult | null;
}

/**
 * Shift Marketplace Manager View phase, §5 of the frontend prompt: current
 * cumulative counts, not a historical trend - no time-series store exists
 * anywhere in this platform, and building one is out of scope for a single
 * dashboard page. `MarketplaceMetricCount` is a flat resource:count pair so
 * the frontend can render a bar per outcome without the schema needing to
 * predict every future label value.
 */
@ObjectType('MarketplaceMetricCount')
export class MarketplaceMetricCountResult {
  @Field(() => String)
  label!: string;

  @Field(() => Number)
  count!: number;
}

@ObjectType('MarketplaceHealthSnapshot')
export class MarketplaceHealthSnapshotResult {
  @Field(() => Number)
  lockContentionTotal!: number;

  /** By `GuardrailValidationService.checkEligibility`'s own `result` label (`pass`/`fail`/`unavailable`). */
  @Field(() => [MarketplaceMetricCountResult])
  guardrailValidationByResult!: MarketplaceMetricCountResult[];

  /** By `ClaimOpenShiftService`'s own `claimAttemptsTotal` `result` label - `rate_limited` is §5.2's distinct anti-abuse signal, never folded into any other outcome. */
  @Field(() => [MarketplaceMetricCountResult])
  claimAttemptsByResult!: MarketplaceMetricCountResult[];
}

/** §3.1's `approveMarketplaceAction` - exactly one of `claim`/`swap` is populated, matching which id the caller passed. Not a GraphQL union - simpler for clients to consume, and this mutation only ever approves one of two known entity types, not an open-ended set. */
@ObjectType('ApproveMarketplaceActionResult')
export class ApproveMarketplaceActionResultType {
  @Field(() => MarketplaceClaimResult, { nullable: true })
  claim!: MarketplaceClaimResult | null;

  @Field(() => SwapRequestResult, { nullable: true })
  swap!: SwapRequestResult | null;
}

@ObjectType('BidOpportunity')
export class BidOpportunityResult {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  marketplacePostId!: string;

  @Field(() => Date)
  biddingWindowStart!: Date;

  @Field(() => Date)
  biddingWindowEnd!: Date;

  @Field(() => String)
  rankingMethod!: string;
}

/** §5.1: `rankPosition`/`rankExplanation` (and, for `preference_score`/`seniority`, `rankScore`) are null until the opportunity closes. */
@ObjectType('Bid')
export class BidResult {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  bidOpportunityId!: string;

  @Field(() => ID)
  employeeId!: string;

  @Field(() => Number, { nullable: true })
  rankScore!: number | null;

  @Field(() => Number, { nullable: true })
  rankPosition!: number | null;

  @Field(() => Object, { nullable: true })
  rankExplanation!: Record<string, unknown> | null;

  @Field(() => Date)
  submittedAt!: Date;
}

/** §2.2 rule 3/Phase 7 (ADR-0091): the current running totals - `badges` is the full, ever-growing set an employee has earned, not just this event's own newly-awarded ones (see `MarketplaceEngagementEventResult.badgesAwarded` for that). */
@ObjectType('MarketplaceEngagementScore')
export class MarketplaceEngagementScoreResult {
  @Field(() => ID)
  employeeId!: string;

  @Field(() => Number)
  points!: number;

  @Field(() => Number)
  streakDays!: number;

  @Field(() => [String])
  badges!: string[];

  @Field(() => String, { nullable: true })
  lastEngagementDate!: string | null;
}

/** Phase 7 (ADR-0091): one ledger row - "which action earned it and when," the audit trail `MarketplaceEngagementScore` alone can't answer. */
@ObjectType('MarketplaceEngagementEvent')
export class MarketplaceEngagementEventResult {
  @Field(() => ID)
  id!: string;

  @Field(() => String)
  eventType!: string;

  @Field(() => ID)
  referenceId!: string;

  @Field(() => Number)
  pointsDelta!: number;

  @Field(() => Number)
  streakDaysAfter!: number;

  @Field(() => [String])
  badgesAwarded!: string[];

  @Field(() => Date)
  createdAt!: Date;
}
