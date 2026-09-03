import { DataSource, EntityManager } from 'typeorm';
import { NlAnalyticsBridgeService } from '../../../src/ai/nl-analytics-bridge.service';
import { LlmClient } from '../../../src/ai/llm/llm-client';
import { AiProviderConfigService } from '../../../src/ai/ai-provider-config.service';
import { AiProviderNotConfiguredError } from '../../../src/ai/errors/ai-provider-not-configured.error';
import { LlmCallFailedError } from '../../../src/ai/llm/llm-call-failed.error';
import { AiInteractionRateLimiterService } from '../../../src/auth/ai-interaction-rate-limiter.service';
import { AuditGrpcClientService } from '../../../src/grpc/audit-grpc-client.service';
import { MetricsService } from '../../../src/common/metrics/metrics.service';
import { AnalyticsNlBridgeUnavailableError } from '../../../src/ai/errors/analytics-nl-bridge-unavailable.error';
import { AnalyticsNlBridgeRateLimitedError } from '../../../src/ai/errors/analytics-nl-bridge-rate-limited.error';
import { AnalyticsQuestionTooLongError } from '../../../src/ai/errors/analytics-question-too-long.error';
import { AiLlmProvider } from '../../../src/ai/entities/ai-provider-config.entity';
import { AiInteraction, AiInteractionType } from '../../../src/ai/entities/ai-interaction.entity';

const TENANT_A = '11111111-1111-1111-1111-111111111111';

/** Own copy of every other spec's own `buildDataSource` (see ask-question.service.spec.ts). */
function buildDataSource(): { dataSource: DataSource; savedInteractions: unknown[] } {
  const savedInteractions: unknown[] = [];
  const manager = {
    query: jest.fn().mockResolvedValue(undefined),
    save: jest.fn((_entityClass: unknown, entity: unknown) => {
      savedInteractions.push(entity);
      return Promise.resolve(entity);
    }),
  } as unknown as EntityManager;
  const dataSource = {
    transaction: jest.fn((work: (manager: EntityManager) => Promise<unknown>) => work(manager)),
  } as unknown as DataSource;
  return { dataSource, savedInteractions };
}

describe('NlAnalyticsBridgeService', () => {
  let llmClient: { complete: jest.Mock };
  let aiProviderConfig: { resolveForCall: jest.Mock };
  let rateLimiter: { tryAcquire: jest.Mock };
  let auditClient: { recordEvent: jest.Mock };
  let metrics: MetricsService;

  function buildService(dataSource: DataSource): NlAnalyticsBridgeService {
    return new NlAnalyticsBridgeService(
      dataSource,
      llmClient as unknown as LlmClient,
      aiProviderConfig as unknown as AiProviderConfigService,
      rateLimiter as unknown as AiInteractionRateLimiterService,
      auditClient as unknown as AuditGrpcClientService,
      metrics,
    );
  }

  beforeEach(() => {
    llmClient = { complete: jest.fn() };
    aiProviderConfig = { resolveForCall: jest.fn() };
    rateLimiter = { tryAcquire: jest.fn().mockReturnValue({ allowed: true }) };
    auditClient = { recordEvent: jest.fn().mockResolvedValue(undefined) };
    metrics = new MetricsService();
    metrics.onModuleInit();
  });

  describe('translateQuestion', () => {
    it('rejects a question over 4000 characters before any LLM/rate-limit cost', async () => {
      const { dataSource } = buildDataSource();
      const service = buildService(dataSource);

      await expect(service.translateQuestion(TENANT_A, null, 'x'.repeat(4001), ['adherence_trend'])).rejects.toThrow(
        AnalyticsQuestionTooLongError,
      );
      expect(rateLimiter.tryAcquire).not.toHaveBeenCalled();
    });

    it('throws AnalyticsNlBridgeRateLimitedError when the shared limiter denies the call', async () => {
      rateLimiter.tryAcquire.mockReturnValue({ allowed: false, retryAfterSeconds: 42 });
      const { dataSource } = buildDataSource();
      const service = buildService(dataSource);

      await expect(
        service.translateQuestion(TENANT_A, 'user-1', 'How is adherence trending?', ['adherence_trend']),
      ).rejects.toThrow(AnalyticsNlBridgeRateLimitedError);
      expect(llmClient.complete).not.toHaveBeenCalled();
    });

    it('translates a metric_query question, validating metricName against the real catalog', async () => {
      aiProviderConfig.resolveForCall.mockResolvedValue({
        provider: AiLlmProvider.ANTHROPIC,
        model: 'claude-test-model',
        apiKey: 'sk-test',
      });
      llmClient.complete.mockResolvedValue({
        model: 'claude-test-model',
        text: JSON.stringify({
          kind: 'metric_query',
          metricName: 'adherence_trend',
          orgUnitId: null,
          period: null,
          selfReportedConfidence: 0.9,
        }),
      });
      const { dataSource, savedInteractions } = buildDataSource();
      const service = buildService(dataSource);

      const result = await service.translateQuestion(TENANT_A, 'user-1', 'How is adherence trending?', [
        'adherence_trend',
        'forecast_accuracy_mape',
      ]);

      expect(result).toEqual({
        kind: 'metric_query',
        metricName: 'adherence_trend',
        orgUnitId: null,
        period: null,
        selfReportedConfidence: 0.9,
      });
      expect(savedInteractions).toHaveLength(1);
      const saved = savedInteractions[0] as AiInteraction;
      expect(saved.interactionType).toBe(AiInteractionType.ANALYTICS_NL_BRIDGE);
      expect(saved.degradedMode).toBe(false);
      expect((saved.inputContext as { step: string }).step).toBe('translate_question');
    });

    it('has no non-LLM fallback: a hallucinated metricName is rejected, persists a degraded row, and throws unavailable', async () => {
      aiProviderConfig.resolveForCall.mockResolvedValue({
        provider: AiLlmProvider.ANTHROPIC,
        model: 'claude-test-model',
        apiKey: 'sk-test',
      });
      llmClient.complete.mockResolvedValue({
        model: 'claude-test-model',
        text: JSON.stringify({
          kind: 'metric_query',
          metricName: 'not_a_real_metric',
          selfReportedConfidence: 0.9,
        }),
      });
      const { dataSource, savedInteractions } = buildDataSource();
      const service = buildService(dataSource);

      await expect(
        service.translateQuestion(TENANT_A, null, 'How is adherence trending?', ['adherence_trend']),
      ).rejects.toThrow(AnalyticsNlBridgeUnavailableError);

      expect(savedInteractions).toHaveLength(1);
      const saved = savedInteractions[0] as AiInteraction;
      expect(saved.degradedMode).toBe(true);
      expect(saved.outputStructured).toBeNull();
    });

    it('degrades cleanly when no provider is configured for this tenant', async () => {
      aiProviderConfig.resolveForCall.mockRejectedValue(new AiProviderNotConfiguredError(TENANT_A));
      const { dataSource, savedInteractions } = buildDataSource();
      const service = buildService(dataSource);

      await expect(
        service.translateQuestion(TENANT_A, null, 'How is adherence trending?', ['adherence_trend']),
      ).rejects.toThrow(AnalyticsNlBridgeUnavailableError);
      expect(savedInteractions).toHaveLength(1);
      expect(auditClient.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ai.analytics_nl_bridge.translated' }),
      );
    });
  });

  describe('generateAnswer', () => {
    it('generates prose grounded in the supplied results and persists a real AIInteraction', async () => {
      aiProviderConfig.resolveForCall.mockResolvedValue({
        provider: AiLlmProvider.OPENAI,
        model: 'gpt-test-model',
        apiKey: 'sk-test',
      });
      llmClient.complete.mockResolvedValue({
        model: 'gpt-test-model',
        text: JSON.stringify({
          summaryText: 'Adherence rose from 88% to 91%.',
          topConstraints: { value: 91 },
          tradeOffs: {},
          selfReportedConfidence: 0.85,
        }),
      });
      const { dataSource, savedInteractions } = buildDataSource();
      const service = buildService(dataSource);

      const answer = await service.generateAnswer(TENANT_A, 'user-1', 'How is adherence trending?', [
        { metric: 'adherence_trend', value: 91, periodStart: '2026-07-01', periodEnd: '2026-08-01' },
      ]);

      expect(answer).toBe('Adherence rose from 88% to 91%.');
      expect(savedInteractions).toHaveLength(1);
      const saved = savedInteractions[0] as AiInteraction;
      expect(saved.interactionType).toBe(AiInteractionType.ANALYTICS_NL_BRIDGE);
      expect((saved.inputContext as { step: string }).step).toBe('generate_answer');
    });

    it('has no non-LLM fallback: a failed LLM call persists a degraded row and throws unavailable, never a raw dump of results', async () => {
      aiProviderConfig.resolveForCall.mockResolvedValue({
        provider: AiLlmProvider.ANTHROPIC,
        model: 'claude-test-model',
        apiKey: 'sk-test',
      });
      llmClient.complete.mockRejectedValue(new LlmCallFailedError(new Error('provider unreachable')));
      const { dataSource, savedInteractions } = buildDataSource();
      const service = buildService(dataSource);

      await expect(service.generateAnswer(TENANT_A, null, 'How is adherence trending?', [])).rejects.toThrow(
        AnalyticsNlBridgeUnavailableError,
      );

      expect(savedInteractions).toHaveLength(1);
      const saved = savedInteractions[0] as AiInteraction;
      expect(saved.degradedMode).toBe(true);
      expect(saved.outputText).toBeNull();
    });

    it('throws AnalyticsNlBridgeRateLimitedError when the shared limiter denies the call', async () => {
      rateLimiter.tryAcquire.mockReturnValue({ allowed: false, retryAfterSeconds: 7 });
      const { dataSource } = buildDataSource();
      const service = buildService(dataSource);

      await expect(service.generateAnswer(TENANT_A, 'user-1', 'question', [])).rejects.toThrow(
        AnalyticsNlBridgeRateLimitedError,
      );
      expect(llmClient.complete).not.toHaveBeenCalled();
    });
  });
});
