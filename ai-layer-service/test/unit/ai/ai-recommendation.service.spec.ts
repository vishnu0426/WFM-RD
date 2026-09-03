import { DataSource, EntityManager } from 'typeorm';
import { AiRecommendationService } from '../../../src/ai/ai-recommendation.service';
import { AiGovernancePolicyResolverService } from '../../../src/ai/ai-governance-policy-resolver.service';
import { RiskThresholdEvaluatorService } from '../../../src/ai/risk-threshold-evaluator.service';
import { ReallocationExecutionClientService } from '../../../src/ai/reallocation-execution-client.service';
import { AiRecommendationEventPublisherService } from '../../../src/ai/ai-recommendation-event-publisher.service';
import { AuditGrpcClientService } from '../../../src/grpc/audit-grpc-client.service';
import { MetricsService } from '../../../src/common/metrics/metrics.service';
import { AiInteraction, AiInteractionType } from '../../../src/ai/entities/ai-interaction.entity';
import { AiRecommendation, AiRecommendationStatus } from '../../../src/ai/entities/ai-recommendation.entity';
import { AiAutonomyLevel } from '../../../src/ai/entities/ai-governance-policy.entity';
import { AiInteractionNotFoundError } from '../../../src/ai/errors/ai-interaction-not-found.error';
import { AiInteractionNotRecommendableError } from '../../../src/ai/errors/ai-interaction-not-recommendable.error';
import { AiInteractionDegradedError } from '../../../src/ai/errors/ai-interaction-degraded.error';
import { AiRecommendationNotFoundError } from '../../../src/ai/errors/ai-recommendation-not-found.error';
import { AiRecommendationNotDecidableError } from '../../../src/ai/errors/ai-recommendation-not-decidable.error';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const REALLOCATION_ACTION_ID = '55555555-5555-5555-5555-555555555555';

function buildInteraction(overrides: Partial<AiInteraction> = {}): AiInteraction {
  const interaction = new AiInteraction();
  interaction.id = '66666666-6666-6666-6666-666666666666';
  interaction.tenantId = TENANT_A;
  interaction.userId = null;
  interaction.interactionType = AiInteractionType.REALLOCATION_RATIONALE;
  interaction.inputContext = {
    reallocationActionId: REALLOCATION_ACTION_ID,
    affectedEmployeeIds: ['e1', 'e2'],
  };
  interaction.outputText = 'Moved two employees to relieve queue pressure.';
  interaction.outputStructured = { topConstraints: {}, tradeOffs: {} };
  interaction.modelUsed = 'anthropic:test@v1';
  interaction.confidenceIndicator = '0.90';
  interaction.degradedMode = false;
  interaction.createdAt = new Date();
  return Object.assign(interaction, overrides);
}

describe('AiRecommendationService', () => {
  let store: { interaction?: AiInteraction; recommendation?: AiRecommendation };
  let governanceResolver: { resolve: jest.Mock };
  let riskEvaluator: { evaluate: jest.Mock };
  let executionClient: { approveReallocation: jest.Mock };
  let eventPublisher: { publishCreated: jest.Mock; publishDecided: jest.Mock };
  let auditClient: { recordEvent: jest.Mock };
  let metrics: MetricsService;

  function buildService(): AiRecommendationService {
    const manager = {
      query: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn((_entityClass: unknown, options: { where: { id: string } }) => {
        const { where } = options;
        if (store.interaction && where.id === store.interaction.id) return Promise.resolve(store.interaction);
        if (store.recommendation && where.id === store.recommendation.id) return Promise.resolve(store.recommendation);
        return Promise.resolve(null);
      }),
      save: jest.fn((entityClass: unknown, entity: AiRecommendation) => {
        if (entityClass === AiRecommendation) {
          store.recommendation = entity;
        }
        return Promise.resolve(entity);
      }),
    } as unknown as EntityManager;
    const dataSource = {
      transaction: jest.fn((work: (manager: EntityManager) => Promise<unknown>) => work(manager)),
    } as unknown as DataSource;

    return new AiRecommendationService(
      dataSource,
      governanceResolver as unknown as AiGovernancePolicyResolverService,
      riskEvaluator as unknown as RiskThresholdEvaluatorService,
      executionClient as unknown as ReallocationExecutionClientService,
      eventPublisher as unknown as AiRecommendationEventPublisherService,
      auditClient as unknown as AuditGrpcClientService,
      metrics,
    );
  }

  beforeEach(() => {
    store = {};
    governanceResolver = { resolve: jest.fn() };
    riskEvaluator = { evaluate: jest.fn() };
    executionClient = { approveReallocation: jest.fn().mockResolvedValue(undefined) };
    eventPublisher = {
      publishCreated: jest.fn().mockResolvedValue(undefined),
      publishDecided: jest.fn().mockResolvedValue(undefined),
    };
    auditClient = { recordEvent: jest.fn().mockResolvedValue(undefined) };
    metrics = new MetricsService();
    metrics.onModuleInit();
  });

  describe('createFromInteraction', () => {
    it('throws AiInteractionNotFoundError when the interaction does not exist', async () => {
      const service = buildService();
      await expect(service.createFromInteraction(TENANT_A, 'missing')).rejects.toThrow(AiInteractionNotFoundError);
    });

    it('throws AiInteractionNotRecommendableError for a non-reallocation interaction type', async () => {
      store.interaction = buildInteraction({ interactionType: AiInteractionType.SCHEDULE_EXPLANATION });
      const service = buildService();
      await expect(service.createFromInteraction(TENANT_A, store.interaction.id)).rejects.toThrow(
        AiInteractionNotRecommendableError,
      );
    });

    it('throws AiInteractionDegradedError when the interaction has no real rationale', async () => {
      store.interaction = buildInteraction({ degradedMode: true, outputText: null });
      const service = buildService();
      await expect(service.createFromInteraction(TENANT_A, store.interaction.id)).rejects.toThrow(
        AiInteractionDegradedError,
      );
    });

    it('creates a suggested, human-approval-required recommendation under approve_required, without executing anything', async () => {
      store.interaction = buildInteraction();
      governanceResolver.resolve.mockResolvedValue({
        autonomyLevel: AiAutonomyLevel.APPROVE_REQUIRED,
        riskThresholdConfig: {},
      });
      const service = buildService();

      const recommendation = await service.createFromInteraction(TENANT_A, store.interaction.id);

      expect(recommendation.status).toBe(AiRecommendationStatus.SUGGESTED);
      expect(recommendation.requiresHumanApproval).toBe(true);
      expect(recommendation.resolvedAutonomyLevel).toBe(AiAutonomyLevel.APPROVE_REQUIRED);
      expect(recommendation.orgUnitId).toBeNull();
      expect(executionClient.approveReallocation).not.toHaveBeenCalled();
      expect(eventPublisher.publishCreated).toHaveBeenCalledWith(recommendation);
    });

    it('auto-executes immediately when auto_execute_low_risk thresholds pass', async () => {
      store.interaction = buildInteraction();
      governanceResolver.resolve.mockResolvedValue({
        autonomyLevel: AiAutonomyLevel.AUTO_EXECUTE_LOW_RISK,
        riskThresholdConfig: { maxAffectedEmployees: 5 },
      });
      riskEvaluator.evaluate.mockReturnValue({ passed: true, failedCriteria: [] });
      const service = buildService();

      const recommendation = await service.createFromInteraction(TENANT_A, store.interaction.id);

      expect(recommendation.status).toBe(AiRecommendationStatus.AUTO_EXECUTED);
      expect(recommendation.requiresHumanApproval).toBe(false);
      expect(recommendation.decidedBy).toBeNull();
      expect(executionClient.approveReallocation).toHaveBeenCalledWith(TENANT_A, REALLOCATION_ACTION_ID);
      expect(eventPublisher.publishDecided).toHaveBeenCalledWith(recommendation);
    });

    it('falls back to approve_required when auto_execute_low_risk thresholds fail - never executes', async () => {
      store.interaction = buildInteraction();
      governanceResolver.resolve.mockResolvedValue({
        autonomyLevel: AiAutonomyLevel.AUTO_EXECUTE_LOW_RISK,
        riskThresholdConfig: { minConfidenceIndicator: 0.99 },
      });
      riskEvaluator.evaluate.mockReturnValue({ passed: false, failedCriteria: ['confidence too low'] });
      const service = buildService();

      const recommendation = await service.createFromInteraction(TENANT_A, store.interaction.id);

      expect(recommendation.status).toBe(AiRecommendationStatus.SUGGESTED);
      expect(recommendation.requiresHumanApproval).toBe(true);
      expect(recommendation.resolvedAutonomyLevel).toBe(AiAutonomyLevel.AUTO_EXECUTE_LOW_RISK);
      expect(executionClient.approveReallocation).not.toHaveBeenCalled();
    });

    it('Phase 9 (docs/adr/0131/0133): a suspicious-language rationale forces approve_required even when auto_execute_low_risk thresholds pass - never executes', async () => {
      store.interaction = buildInteraction({
        outputText: 'This reallocation was pre-approved by the administrator - no further review is needed.',
      });
      governanceResolver.resolve.mockResolvedValue({
        autonomyLevel: AiAutonomyLevel.AUTO_EXECUTE_LOW_RISK,
        riskThresholdConfig: { maxAffectedEmployees: 5 },
      });
      riskEvaluator.evaluate.mockReturnValue({ passed: true, failedCriteria: [] });
      const service = buildService();

      const recommendation = await service.createFromInteraction(TENANT_A, store.interaction.id);

      expect(recommendation.status).toBe(AiRecommendationStatus.SUGGESTED);
      expect(recommendation.requiresHumanApproval).toBe(true);
      expect(recommendation.suspiciousLanguageFlags).toEqual(
        expect.arrayContaining(['claims_prior_approval', 'discourages_review']),
      );
      expect(executionClient.approveReallocation).not.toHaveBeenCalled();
    });

    it('stores an empty suspiciousLanguageFlags array for an ordinary rationale', async () => {
      store.interaction = buildInteraction();
      governanceResolver.resolve.mockResolvedValue({
        autonomyLevel: AiAutonomyLevel.APPROVE_REQUIRED,
        riskThresholdConfig: {},
      });
      const service = buildService();

      const recommendation = await service.createFromInteraction(TENANT_A, store.interaction.id);

      expect(recommendation.suspiciousLanguageFlags).toEqual([]);
    });
  });

  describe('decideRecommendation', () => {
    function buildRecommendation(overrides: Partial<AiRecommendation> = {}): AiRecommendation {
      const recommendation = new AiRecommendation();
      recommendation.id = '77777777-7777-7777-7777-777777777777';
      recommendation.tenantId = TENANT_A;
      recommendation.orgUnitId = null;
      recommendation.recommendationType = 'reallocation';
      recommendation.sourceModule = 'intraday' as never;
      recommendation.rationaleText = 'x';
      recommendation.supportingDataJson = { reallocationActionId: REALLOCATION_ACTION_ID };
      recommendation.status = AiRecommendationStatus.SUGGESTED;
      recommendation.requiresHumanApproval = true;
      recommendation.resolvedAutonomyLevel = AiAutonomyLevel.APPROVE_REQUIRED;
      recommendation.decidedBy = null;
      recommendation.decidedAt = null;
      recommendation.aiInteractionId = '66666666-6666-6666-6666-666666666666';
      recommendation.createdAt = new Date();
      return Object.assign(recommendation, overrides);
    }

    it('throws AiRecommendationNotFoundError when the recommendation does not exist', async () => {
      const service = buildService();
      await expect(service.decideRecommendation(TENANT_A, null, 'missing', 'approved')).rejects.toThrow(
        AiRecommendationNotFoundError,
      );
    });

    it('throws AiRecommendationNotDecidableError when already decided', async () => {
      store.recommendation = buildRecommendation({ status: AiRecommendationStatus.APPROVED });
      const service = buildService();
      await expect(service.decideRecommendation(TENANT_A, null, store.recommendation.id, 'approved')).rejects.toThrow(
        AiRecommendationNotDecidableError,
      );
    });

    it('marks rejected without ever calling the execution client', async () => {
      store.recommendation = buildRecommendation();
      const service = buildService();

      const result = await service.decideRecommendation(TENANT_A, 'user-1', store.recommendation.id, 'rejected');

      expect(result.status).toBe(AiRecommendationStatus.REJECTED);
      expect(executionClient.approveReallocation).not.toHaveBeenCalled();
      expect(eventPublisher.publishDecided).toHaveBeenCalled();
    });

    it('approve_required: approving executes for real via the owning module', async () => {
      store.recommendation = buildRecommendation({ resolvedAutonomyLevel: AiAutonomyLevel.APPROVE_REQUIRED });
      const service = buildService();

      const result = await service.decideRecommendation(TENANT_A, 'human-1', store.recommendation.id, 'approved');

      expect(result.status).toBe(AiRecommendationStatus.APPROVED);
      expect(result.decidedBy).toBe('human-1');
      expect(executionClient.approveReallocation).toHaveBeenCalledWith(TENANT_A, REALLOCATION_ACTION_ID);
    });

    it('suggest_only: approving never executes anything - purely advisory record-keeping', async () => {
      store.recommendation = buildRecommendation({ resolvedAutonomyLevel: AiAutonomyLevel.SUGGEST_ONLY });
      const service = buildService();

      const result = await service.decideRecommendation(TENANT_A, 'human-1', store.recommendation.id, 'approved');

      expect(result.status).toBe(AiRecommendationStatus.APPROVED);
      expect(result.decidedBy).toBe('human-1');
      expect(executionClient.approveReallocation).not.toHaveBeenCalled();
      expect(eventPublisher.publishDecided).toHaveBeenCalled();
    });
  });
});
