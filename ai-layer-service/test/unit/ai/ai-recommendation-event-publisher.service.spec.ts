import { AiRecommendationEventPublisherService } from '../../../src/ai/ai-recommendation-event-publisher.service';
import { AiNatsClientService } from '../../../src/nats/ai-nats-client.service';
import { AI_RECOMMENDATION_CREATED_SUBJECT, AI_RECOMMENDATION_DECIDED_SUBJECT } from '../../../src/nats/subjects';
import {
  AiRecommendation,
  AiRecommendationStatus,
  AiRecommendationSourceModule,
} from '../../../src/ai/entities/ai-recommendation.entity';
import { AiAutonomyLevel } from '../../../src/ai/entities/ai-governance-policy.entity';

function buildRecommendation(): AiRecommendation {
  const recommendation = new AiRecommendation();
  recommendation.id = 'r1';
  recommendation.tenantId = 't1';
  recommendation.orgUnitId = null;
  recommendation.recommendationType = 'reallocation';
  recommendation.sourceModule = AiRecommendationSourceModule.INTRADAY;
  recommendation.rationaleText = 'x';
  recommendation.supportingDataJson = {};
  recommendation.status = AiRecommendationStatus.SUGGESTED;
  recommendation.requiresHumanApproval = true;
  recommendation.resolvedAutonomyLevel = AiAutonomyLevel.APPROVE_REQUIRED;
  recommendation.decidedBy = null;
  recommendation.decidedAt = null;
  recommendation.aiInteractionId = 'i1';
  recommendation.createdAt = new Date('2026-01-01T00:00:00Z');
  return recommendation;
}

describe('AiRecommendationEventPublisherService', () => {
  it('publishes AIRecommendationCreated with the expected payload shape', async () => {
    const nats = { publish: jest.fn().mockResolvedValue(undefined) };
    const service = new AiRecommendationEventPublisherService(nats as unknown as AiNatsClientService);

    await service.publishCreated(buildRecommendation());

    expect(nats.publish).toHaveBeenCalledWith(
      AI_RECOMMENDATION_CREATED_SUBJECT,
      expect.objectContaining({ id: 'r1', tenantId: 't1', status: 'suggested' }),
      'r1',
    );
  });

  it('publishes AIRecommendationDecided on the decided subject', async () => {
    const nats = { publish: jest.fn().mockResolvedValue(undefined) };
    const service = new AiRecommendationEventPublisherService(nats as unknown as AiNatsClientService);

    await service.publishDecided(buildRecommendation());

    expect(nats.publish).toHaveBeenCalledWith(AI_RECOMMENDATION_DECIDED_SUBJECT, expect.anything(), 'r1');
  });

  it('never throws when the underlying NATS publish fails - best-effort, logged and swallowed', async () => {
    const nats = { publish: jest.fn().mockRejectedValue(new Error('nats down')) };
    const service = new AiRecommendationEventPublisherService(nats as unknown as AiNatsClientService);

    await expect(service.publishCreated(buildRecommendation())).resolves.toBeUndefined();
  });
});
