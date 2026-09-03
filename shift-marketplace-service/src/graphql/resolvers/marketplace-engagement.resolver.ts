import { Query, Resolver } from '@nestjs/graphql';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { MarketplaceEngagementQueryService } from '../../marketplace/marketplace-engagement-query.service';
import { MarketplaceEngagementScore } from '../../marketplace/entities/marketplace-engagement-score.entity';
import { MarketplaceEngagementEvent } from '../../marketplace/entities/marketplace-engagement-event.entity';
import { MarketplaceEngagementEventResult, MarketplaceEngagementScoreResult } from '../../marketplace/types';

/**
 * §2.2 rule 3/Phase 7 (ADR-0091): "queryable data" - always the bound
 * actor's own standing, never an arbitrary `employeeId` argument, same
 * context-bound-actor posture every other mutation/query in this service
 * already takes (ADR-0084). No supervisor-viewing-a-report's-score surface
 * exists yet - that's a real RBAC concern this platform doesn't have
 * anywhere, not something to invent as a one-off here.
 */
@Resolver()
export class MarketplaceEngagementResolver {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly engagementQuery: MarketplaceEngagementQueryService,
  ) {}

  @Query(() => MarketplaceEngagementScoreResult, { name: 'myMarketplaceEngagement', nullable: true })
  async myMarketplaceEngagement(): Promise<MarketplaceEngagementScoreResult | null> {
    const tenantId = this.tenantContext.requireTenantId();
    const employeeId = this.tenantContext.requireActorId();
    const score = await this.engagementQuery.findScore(tenantId, employeeId);
    return score ? toScoreResult(score) : null;
  }

  @Query(() => [MarketplaceEngagementEventResult], { name: 'myMarketplaceEngagementEvents' })
  async myMarketplaceEngagementEvents(): Promise<MarketplaceEngagementEventResult[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const employeeId = this.tenantContext.requireActorId();
    const events = await this.engagementQuery.findEvents(tenantId, employeeId);
    return events.map(toEventResult);
  }
}

function toScoreResult(score: MarketplaceEngagementScore): MarketplaceEngagementScoreResult {
  return {
    employeeId: score.employeeId,
    points: score.points,
    streakDays: score.streakDays,
    badges: score.badges as string[],
    lastEngagementDate: score.lastEngagementDate,
  };
}

function toEventResult(event: MarketplaceEngagementEvent): MarketplaceEngagementEventResult {
  return {
    id: event.id,
    eventType: event.eventType,
    referenceId: event.referenceId,
    pointsDelta: event.pointsDelta,
    streakDaysAfter: event.streakDaysAfter,
    badgesAwarded: event.badgesAwarded,
    createdAt: event.createdAt,
  };
}
