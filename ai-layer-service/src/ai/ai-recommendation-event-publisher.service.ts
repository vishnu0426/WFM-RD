import { Injectable, Logger } from '@nestjs/common';
import { AiNatsClientService } from '../nats/ai-nats-client.service';
import { AI_RECOMMENDATION_CREATED_SUBJECT, AI_RECOMMENDATION_DECIDED_SUBJECT } from '../nats/subjects';
import { AiRecommendation } from './entities/ai-recommendation.entity';

/**
 * §4's event backbone: "publishes `AIRecommendationCreated`/`AIRecommendationDecided`
 * for Module 01 audit consumption and any module awaiting a decided
 * recommendation." Best-effort, fire-and-forget, non-transactional with
 * Postgres - the same convention every other standalone service's own NATS
 * publisher in this platform follows (attendance-leave-service's
 * `DecideLeaveRequestService`/shift-marketplace-service's
 * `MarketplaceEventPublisherService`): a failed publish is logged and
 * swallowed, a monitored propagation gap, not a reason to fail a mutation
 * that already committed its real (Postgres) state change. Building a
 * durable outbox table (Module 01/02's own `core.outbox_events` pattern)
 * is explicitly out of scope for this phase - no standalone service in
 * this platform has one either.
 */
@Injectable()
export class AiRecommendationEventPublisherService {
  private readonly logger = new Logger(AiRecommendationEventPublisherService.name);

  constructor(private readonly nats: AiNatsClientService) {}

  async publishCreated(recommendation: AiRecommendation): Promise<void> {
    await this.publish(AI_RECOMMENDATION_CREATED_SUBJECT, recommendation);
  }

  async publishDecided(recommendation: AiRecommendation): Promise<void> {
    await this.publish(AI_RECOMMENDATION_DECIDED_SUBJECT, recommendation);
  }

  private async publish(subject: string, recommendation: AiRecommendation): Promise<void> {
    try {
      await this.nats.publish(
        subject,
        {
          id: recommendation.id,
          tenantId: recommendation.tenantId,
          recommendationType: recommendation.recommendationType,
          sourceModule: recommendation.sourceModule,
          status: recommendation.status,
          requiresHumanApproval: recommendation.requiresHumanApproval,
          decidedBy: recommendation.decidedBy,
          aiInteractionId: recommendation.aiInteractionId,
          createdAt: recommendation.createdAt.toISOString(),
          decidedAt: recommendation.decidedAt ? recommendation.decidedAt.toISOString() : null,
        },
        recommendation.id,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to publish ${subject} for recommendation ${recommendation.id}: ${(err as Error).message}`,
      );
    }
  }
}
