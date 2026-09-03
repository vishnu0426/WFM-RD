import { Module } from '@nestjs/common';
import { MarketplaceRedisModule } from '../redis/redis.module';
import { SchedulingEligibilityGrpcClientModule } from '../grpc/scheduling-eligibility-grpc-client.module';
import { EmployeeGrpcClientModule } from '../grpc/employee-grpc-client.module';
import { MetricsModule } from '../common/metrics/metrics.module';
import { MarketplaceNatsModule } from '../nats/nats.module';
import { migratorPoolProvider } from '../database/migrator-pool.provider';
import { ClaimOpenShiftService } from './claim-open-shift.service';
import { GuardrailValidationService } from './guardrail-validation.service';
import { MarketplacePostQueryService } from './marketplace-post-query.service';
import { SwapRequestService } from './swap-request.service';
import { BidOpportunityService } from './bid-opportunity.service';
import { BidService } from './bid.service';
import { BidCloseSweepService } from './bid-close-sweep.service';
import { TenantMarketplacePolicyService } from './tenant-marketplace-policy.service';
import { MarketplaceEventPublisherService } from './marketplace-event-publisher.service';
import { MarketplaceOutboxEventsRepository } from './repositories/marketplace-outbox-events.repository';
import { MarketplaceOutboxPublisherService } from './marketplace-outbox-publisher.service';
import { ApproveMarketplaceActionService } from './approve-marketplace-action.service';
import { ClaimAttemptRateLimiterService } from './claim-attempt-rate-limiter.service';
import { MarketplaceEngagementService } from './marketplace-engagement.service';
import { MarketplaceEngagementQueryService } from './marketplace-engagement-query.service';
import { PendingMarketplaceActionsQueryService } from './pending-marketplace-actions-query.service';
import { MarketplaceHealthQueryService } from './marketplace-health-query.service';

/**
 * Phase 2 (§4/§8): the concurrency-safe claim flow's core path. Phase 3
 * (`SwapRequestService`) and Phase 4 (`BidOpportunityService`/
 * `BidService`) reuse `GuardrailValidationService` rather than a separate
 * implementation (§8's own instruction). `BidCloseSweepService` is this
 * service's first `@Cron` job (`ScheduleModule.forRoot()`, `app.module.ts`).
 *
 * Phase 5 (ADR-0089): `TenantMarketplacePolicyService` (auto-vs-supervisor
 * approval), `MarketplaceEventPublisherService`/`MarketplaceNatsModule`
 * (the actual Module 04 handoff), and `ApproveMarketplaceActionService`
 * (§3.1's supervisor-approval mutation).
 *
 * Phase 6 (§5.2): `ClaimAttemptRateLimiterService` - anti-abuse rate
 * limiting on claim attempts specifically, distinct from any generic
 * per-tenant request quota.
 *
 * Phase 7 (§2.2 rule 3, ADR-0091): `MarketplaceEngagementService` (points/
 * streak/badge writes + ledger) and `MarketplaceEngagementQueryService`
 * (the read side) - called from `ClaimOpenShiftService`/`SwapRequestService`'s
 * own auto-approval branches and `ApproveMarketplaceActionService`'s
 * supervisor path, the same shared call sites `MarketplaceEventPublisherService`
 * already uses.
 *
 * GAP-02 fix (enterprise readiness audit, 2026-08-18): `MarketplaceEventPublisherService`
 * no longer publishes to NATS directly - it now writes to the transactional
 * outbox (`MarketplaceOutboxEventsRepository`), drained independently by
 * `MarketplaceOutboxPublisherService`'s own `@Cron` tick (same shape as
 * `BidCloseSweepService`'s, reusing `migratorPoolProvider`'s cross-tenant pool).
 */
@Module({
  imports: [
    MarketplaceRedisModule,
    SchedulingEligibilityGrpcClientModule,
    EmployeeGrpcClientModule,
    MetricsModule,
    MarketplaceNatsModule,
  ],
  providers: [
    ClaimOpenShiftService,
    GuardrailValidationService,
    MarketplacePostQueryService,
    SwapRequestService,
    BidOpportunityService,
    BidService,
    BidCloseSweepService,
    TenantMarketplacePolicyService,
    MarketplaceEventPublisherService,
    MarketplaceOutboxEventsRepository,
    MarketplaceOutboxPublisherService,
    ApproveMarketplaceActionService,
    ClaimAttemptRateLimiterService,
    MarketplaceEngagementService,
    MarketplaceEngagementQueryService,
    PendingMarketplaceActionsQueryService,
    MarketplaceHealthQueryService,
    migratorPoolProvider,
  ],
  exports: [
    ClaimOpenShiftService,
    GuardrailValidationService,
    MarketplacePostQueryService,
    SwapRequestService,
    BidOpportunityService,
    BidService,
    TenantMarketplacePolicyService,
    MarketplaceEventPublisherService,
    ApproveMarketplaceActionService,
    ClaimAttemptRateLimiterService,
    MarketplaceEngagementService,
    MarketplaceEngagementQueryService,
    PendingMarketplaceActionsQueryService,
    MarketplaceHealthQueryService,
  ],
})
export class MarketplaceModule {}
