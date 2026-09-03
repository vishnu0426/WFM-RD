import { DataSource, EntityManager } from 'typeorm';
import { AskQuestionService } from '../../../src/ai/ask-question.service';
import { ScheduleExplanationService } from '../../../src/ai/schedule-explanation.service';
import { ForecastExplanationService } from '../../../src/ai/forecast-explanation.service';
import { ReallocationRationaleService } from '../../../src/ai/reallocation-rationale.service';
import { RootCauseAnalysisService } from '../../../src/ai/root-cause-analysis.service';
import { LlmClient } from '../../../src/ai/llm/llm-client';
import { AiProviderConfigService } from '../../../src/ai/ai-provider-config.service';
import { AiProviderNotConfiguredError } from '../../../src/ai/errors/ai-provider-not-configured.error';
import { LlmCallFailedError } from '../../../src/ai/llm/llm-call-failed.error';
import { AuditGrpcClientService } from '../../../src/grpc/audit-grpc-client.service';
import { MetricsService } from '../../../src/common/metrics/metrics.service';
import { AskQuestionContextInvalidError } from '../../../src/ai/errors/ask-question-context-invalid.error';
import { AiAssistantUnavailableError } from '../../../src/ai/errors/ai-assistant-unavailable.error';
import { AiLlmProvider } from '../../../src/ai/entities/ai-provider-config.entity';
import { AiRecommendationService } from '../../../src/ai/ai-recommendation.service';
import { AiInteraction, AiInteractionType } from '../../../src/ai/entities/ai-interaction.entity';
import { AiInteractionNotRecommendableError } from '../../../src/ai/errors/ai-interaction-not-recommendable.error';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const JOB_ID = '22222222-2222-2222-2222-222222222222';

/** A fake DataSource whose `.transaction()` just calls straight through to a fake manager - own copy of every other spec's own `buildDataSource`. */
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

describe('AskQuestionService', () => {
  let scheduleExplanation: { gatherContext: jest.Mock };
  let forecastExplanation: { gatherContext: jest.Mock };
  let reallocationRationale: { gatherContext: jest.Mock };
  let rootCauseAnalysis: { gatherContext: jest.Mock };
  let llmClient: { complete: jest.Mock };
  let aiProviderConfig: { resolveForCall: jest.Mock };
  let auditClient: { recordEvent: jest.Mock };
  let metrics: MetricsService;

  function buildService(dataSource: DataSource): AskQuestionService {
    return new AskQuestionService(
      dataSource,
      scheduleExplanation as unknown as ScheduleExplanationService,
      forecastExplanation as unknown as ForecastExplanationService,
      reallocationRationale as unknown as ReallocationRationaleService,
      rootCauseAnalysis as unknown as RootCauseAnalysisService,
      llmClient as unknown as LlmClient,
      aiProviderConfig as unknown as AiProviderConfigService,
      auditClient as unknown as AuditGrpcClientService,
      metrics,
    );
  }

  beforeEach(() => {
    scheduleExplanation = { gatherContext: jest.fn() };
    forecastExplanation = { gatherContext: jest.fn() };
    reallocationRationale = { gatherContext: jest.fn() };
    rootCauseAnalysis = { gatherContext: jest.fn() };
    llmClient = { complete: jest.fn() };
    aiProviderConfig = { resolveForCall: jest.fn() };
    auditClient = { recordEvent: jest.fn().mockResolvedValue(undefined) };
    metrics = new MetricsService();
    metrics.onModuleInit();
  });

  it('rejects when no source is provided', async () => {
    const { dataSource } = buildDataSource();
    const service = buildService(dataSource);

    await expect(service.askQuestion(TENANT_A, null, 'How was this built?', {})).rejects.toThrow(
      AskQuestionContextInvalidError,
    );
    expect(scheduleExplanation.gatherContext).not.toHaveBeenCalled();
  });

  it('Phase 9 (docs/adr/0133): rejects a question over 4000 characters before even resolving its source (a real cost/DoS guardrail)', async () => {
    const { dataSource } = buildDataSource();
    const service = buildService(dataSource);
    const tooLong = 'x'.repeat(4001);

    await expect(service.askQuestion(TENANT_A, null, tooLong, { scheduleJobId: JOB_ID })).rejects.toThrow(
      AskQuestionContextInvalidError,
    );
    expect(scheduleExplanation.gatherContext).not.toHaveBeenCalled();
  });

  it('rejects when more than one source is provided', async () => {
    const { dataSource } = buildDataSource();
    const service = buildService(dataSource);

    await expect(
      service.askQuestion(TENANT_A, null, 'How was this built?', {
        scheduleJobId: JOB_ID,
        forecastRunId: 'some-forecast-run',
      }),
    ).rejects.toThrow(AskQuestionContextInvalidError);
  });

  it('rejects when orgUnitId is provided without both period bounds', async () => {
    const { dataSource } = buildDataSource();
    const service = buildService(dataSource);

    await expect(
      service.askQuestion(TENANT_A, null, 'How was this built?', { orgUnitId: 'org-1', periodStart: new Date() }),
    ).rejects.toThrow(AskQuestionContextInvalidError);
  });

  it('answers using only the grounding data from the one identified resource (schedule job)', async () => {
    scheduleExplanation.gatherContext.mockResolvedValue({ jobId: JOB_ID, objectiveScore: '123.45' });
    aiProviderConfig.resolveForCall.mockResolvedValue({
      provider: AiLlmProvider.ANTHROPIC,
      model: 'claude-test-model',
      apiKey: 'sk-test',
    });
    llmClient.complete.mockResolvedValue({
      model: 'claude-test-model',
      text: JSON.stringify({
        summaryText: 'The objective score was 123.45.',
        topConstraints: { objectiveScore: '123.45' },
        tradeOffs: {},
        selfReportedConfidence: 0.8,
      }),
    });
    const { dataSource, savedInteractions } = buildDataSource();
    const service = buildService(dataSource);

    const result = await service.askQuestion(TENANT_A, null, 'What was the objective score?', {
      scheduleJobId: JOB_ID,
    });

    expect(forecastExplanation.gatherContext).not.toHaveBeenCalled();
    expect(reallocationRationale.gatherContext).not.toHaveBeenCalled();
    expect(rootCauseAnalysis.gatherContext).not.toHaveBeenCalled();
    expect(result.interactionType).toBe(AiInteractionType.NL_QUERY);
    expect(result.degradedMode).toBe(false);
    expect(result.outputText).toBe('The objective score was 123.45.');
    expect(savedInteractions).toHaveLength(1);
    expect(llmClient.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userContent: expect.stringContaining('What was the objective score?') }),
    );

    expect(auditClient.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'schedule_job', resourceId: JOB_ID }),
    );
  });

  it('routes to the root-cause-analysis gatherContext when orgUnitId + both period bounds are given', async () => {
    rootCauseAnalysis.gatherContext.mockResolvedValue({ orgUnitId: 'org-1', adherence: null });
    aiProviderConfig.resolveForCall.mockRejectedValue(new AiProviderNotConfiguredError(TENANT_A));
    const { dataSource } = buildDataSource();
    const service = buildService(dataSource);
    const periodStart = new Date('2026-01-01');
    const periodEnd = new Date('2026-01-07');

    await expect(
      service.askQuestion(TENANT_A, null, 'Why did adherence drop?', { orgUnitId: 'org-1', periodStart, periodEnd }),
    ).rejects.toThrow(AiAssistantUnavailableError);

    expect(rootCauseAnalysis.gatherContext).toHaveBeenCalledWith(TENANT_A, 'org-1', periodStart, periodEnd);
  });

  it('has no non-LLM fallback: persists a degraded AIInteraction but still throws AiAssistantUnavailableError to the caller', async () => {
    scheduleExplanation.gatherContext.mockResolvedValue({ jobId: JOB_ID });
    aiProviderConfig.resolveForCall.mockResolvedValue({
      provider: AiLlmProvider.OPENAI,
      model: 'gpt-test-model',
      apiKey: 'sk-test',
    });
    llmClient.complete.mockRejectedValue(new LlmCallFailedError(new Error('provider unreachable')));
    const { dataSource, savedInteractions } = buildDataSource();
    const service = buildService(dataSource);

    await expect(service.askQuestion(TENANT_A, null, 'What happened?', { scheduleJobId: JOB_ID })).rejects.toThrow(
      AiAssistantUnavailableError,
    );

    expect(savedInteractions).toHaveLength(1);
    const saved = savedInteractions[0] as AiInteraction;
    expect(saved.degradedMode).toBe(true);
    expect(saved.outputText).toBeNull();
    expect(saved.outputStructured).toBeNull();
    // The attempt is still audited even though it ultimately errors out to the caller.
    expect(auditClient.recordEvent).toHaveBeenCalled();
  });

  it('propagates a not-found error from the underlying gatherContext untouched (never masked as a context-invalid error)', async () => {
    class FakeNotFound extends Error {}
    scheduleExplanation.gatherContext.mockRejectedValue(new FakeNotFound('no such job'));
    const { dataSource } = buildDataSource();
    const service = buildService(dataSource);

    await expect(service.askQuestion(TENANT_A, null, 'What happened?', { scheduleJobId: JOB_ID })).rejects.toThrow(
      FakeNotFound,
    );
  });

  it('human-in-the-loop guarantee: an nl_query interaction can never seed an AIRecommendation', async () => {
    scheduleExplanation.gatherContext.mockResolvedValue({ jobId: JOB_ID });
    aiProviderConfig.resolveForCall.mockResolvedValue({
      provider: AiLlmProvider.ANTHROPIC,
      model: 'claude-test-model',
      apiKey: 'sk-test',
    });
    llmClient.complete.mockResolvedValue({
      model: 'claude-test-model',
      text: JSON.stringify({
        summaryText: 'Answer.',
        topConstraints: {},
        tradeOffs: {},
        selfReportedConfidence: 0.8,
      }),
    });
    const { dataSource, savedInteractions } = buildDataSource();
    const service = buildService(dataSource);

    const nlQueryInteraction = await service.askQuestion(TENANT_A, null, 'What happened?', {
      scheduleJobId: JOB_ID,
    });
    expect(nlQueryInteraction.interactionType).toBe(AiInteractionType.NL_QUERY);

    const findOne = jest.fn((_entityClass: unknown, options: { where: { id: string } }) => {
      const match = (savedInteractions as AiInteraction[]).find((i) => i.id === options.where.id);
      return Promise.resolve(match ?? null);
    });
    const recommendationDataSource = {
      transaction: jest.fn((work: (manager: EntityManager) => Promise<unknown>) =>
        work({ findOne, query: jest.fn().mockResolvedValue(undefined) } as unknown as EntityManager),
      ),
    } as unknown as DataSource;
    const recommendationService = new AiRecommendationService(
      recommendationDataSource,
      { resolve: jest.fn() } as never,
      { evaluate: jest.fn() } as never,
      { execute: jest.fn() } as never,
      {
        publishCreated: jest.fn().mockResolvedValue(undefined),
        publishDecided: jest.fn().mockResolvedValue(undefined),
      } as never,
      auditClient as unknown as AuditGrpcClientService,
      metrics,
    );

    await expect(recommendationService.createFromInteraction(TENANT_A, nlQueryInteraction.id)).rejects.toThrow(
      AiInteractionNotRecommendableError,
    );
  });
});
