import { DataSource, EntityManager } from 'typeorm';
import { ScheduleExplanationService } from '../../../src/ai/schedule-explanation.service';
import { SchedulingGrpcClientService } from '../../../src/grpc/scheduling-grpc-client.service';
import { TenantScopeAssertionService } from '../../../src/ai/tenant-scope-assertion.service';
import { LlmClient } from '../../../src/ai/llm/llm-client';
import { AiProviderConfigService } from '../../../src/ai/ai-provider-config.service';
import { AiProviderNotConfiguredError } from '../../../src/ai/errors/ai-provider-not-configured.error';
import { LlmCallFailedError } from '../../../src/ai/llm/llm-call-failed.error';
import { AuditGrpcClientService } from '../../../src/grpc/audit-grpc-client.service';
import { SchedulingWritebackClientService } from '../../../src/ai/scheduling-writeback-client.service';
import { MetricsService } from '../../../src/common/metrics/metrics.service';
import { ScheduleJobNotFoundError } from '../../../src/ai/errors/schedule-job-not-found.error';
import { CrossTenantDataAssemblyError } from '../../../src/common/tenant/tenant-context.errors';
import { AiLlmProvider } from '../../../src/ai/entities/ai-provider-config.entity';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const JOB_ID = '22222222-2222-2222-2222-222222222222';

function foundJob(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    found: true,
    tenantId: TENANT_A,
    status: 'completed',
    orgUnitId: 'org-1',
    dateRangeStart: '2026-01-01',
    dateRangeEnd: '2026-01-07',
    objectiveScore: '123.45',
    constraintConfigJson: '{"softWeights":{"overtimeCostWeight":1}}',
    relaxationsAppliedJson: '{"minRestHours":{"from":8,"to":6}}',
    decompositionPlanJson: '',
    completedAt: '2026-01-07T12:00:00Z',
    ...overrides,
  };
}

/** A fake DataSource whose `.transaction()` just calls straight through to a fake manager - proves the orchestration without a real Postgres connection. */
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

describe('ScheduleExplanationService', () => {
  let schedulingClient: { getScheduleJobForExplanation: jest.Mock };
  let llmClient: { complete: jest.Mock };
  let aiProviderConfig: { resolveForCall: jest.Mock };
  let auditClient: { recordEvent: jest.Mock };
  let writebackClient: { submitScheduleExplanation: jest.Mock };
  let metrics: MetricsService;

  function buildService(dataSource: DataSource): ScheduleExplanationService {
    return new ScheduleExplanationService(
      dataSource,
      schedulingClient as unknown as SchedulingGrpcClientService,
      new TenantScopeAssertionService(metrics, auditClient as unknown as AuditGrpcClientService),
      llmClient as unknown as LlmClient,
      aiProviderConfig as unknown as AiProviderConfigService,
      auditClient as unknown as AuditGrpcClientService,
      writebackClient as unknown as SchedulingWritebackClientService,
      metrics,
    );
  }

  beforeEach(() => {
    schedulingClient = { getScheduleJobForExplanation: jest.fn() };
    llmClient = { complete: jest.fn() };
    aiProviderConfig = { resolveForCall: jest.fn() };
    auditClient = { recordEvent: jest.fn().mockResolvedValue(undefined) };
    writebackClient = { submitScheduleExplanation: jest.fn().mockResolvedValue(undefined) };
    metrics = new MetricsService();
    metrics.onModuleInit();
  });

  it('throws ScheduleJobNotFoundError when scheduling-service reports found: false', async () => {
    schedulingClient.getScheduleJobForExplanation.mockResolvedValue({ found: false });
    const { dataSource } = buildDataSource();
    const service = buildService(dataSource);

    await expect(service.explainSchedule(TENANT_A, null, JOB_ID)).rejects.toThrow(ScheduleJobNotFoundError);
    expect(llmClient.complete).not.toHaveBeenCalled();
  });

  it('rejects before any LLM call when the gRPC response is scoped to a different tenant (§5.1)', async () => {
    schedulingClient.getScheduleJobForExplanation.mockResolvedValue(foundJob({ tenantId: 'some-other-tenant' }));
    const { dataSource } = buildDataSource();
    const service = buildService(dataSource);

    await expect(service.explainSchedule(TENANT_A, null, JOB_ID)).rejects.toThrow(CrossTenantDataAssemblyError);
    expect(llmClient.complete).not.toHaveBeenCalled();
    // No AIInteraction was ever created, so ScheduleExplanationService's own
    // "ai.schedule_explanation.generated" audit event never fires - but
    // TenantScopeAssertionService's own durable security-event audit write
    // (docs/adr/0118) does, and must.
    expect(auditClient.recordEvent).toHaveBeenCalledTimes(1);
    expect(auditClient.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'security.cross_tenant_data_assembly_detected' }),
    );
  });

  it('persists a real AIInteraction with a confidence indicator on the happy path, then audits and writes back', async () => {
    schedulingClient.getScheduleJobForExplanation.mockResolvedValue(foundJob());
    aiProviderConfig.resolveForCall.mockResolvedValue({
      provider: AiLlmProvider.ANTHROPIC,
      model: 'claude-test-model',
      apiKey: 'sk-test',
    });
    llmClient.complete.mockResolvedValue({
      model: 'claude-test-model',
      text: JSON.stringify({
        summaryText: 'This schedule relaxed the minimum rest constraint from 8 to 6 hours.',
        topConstraints: { minRestHours: { from: 8, to: 6 } },
        tradeOffs: {},
        selfReportedConfidence: 0.9,
      }),
    });
    const { dataSource, savedInteractions } = buildDataSource();
    const service = buildService(dataSource);

    const result = await service.explainSchedule(TENANT_A, null, JOB_ID);

    expect(result.degradedMode).toBe(false);
    expect(result.outputText).toContain('relaxed the minimum rest constraint');
    expect(result.modelUsed).toBe('anthropic:claude-test-model@schedule-explanation-v1');
    expect(Number(result.confidenceIndicator)).toBeGreaterThan(0);
    expect(savedInteractions).toHaveLength(1);

    expect(auditClient.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_A, actorType: 'ai_agent', resourceId: JOB_ID }),
    );
    expect(writebackClient.submitScheduleExplanation).toHaveBeenCalledWith(
      TENANT_A,
      JOB_ID,
      expect.stringContaining('relaxed the minimum rest constraint'),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('enters degraded mode (never crashes) when the LLM call fails, and skips the write-back', async () => {
    schedulingClient.getScheduleJobForExplanation.mockResolvedValue(foundJob());
    aiProviderConfig.resolveForCall.mockResolvedValue({
      provider: AiLlmProvider.OPENAI,
      model: 'gpt-test-model',
      apiKey: 'sk-test',
    });
    llmClient.complete.mockRejectedValue(new LlmCallFailedError(new Error('provider unreachable')));
    const { dataSource, savedInteractions } = buildDataSource();
    const service = buildService(dataSource);

    const result = await service.explainSchedule(TENANT_A, null, JOB_ID);

    expect(result.degradedMode).toBe(true);
    expect(result.outputText).toBeNull();
    expect(result.confidenceIndicator).toBeNull();
    // The raw structured data is still returned, never nothing at all.
    expect(result.outputStructured).toEqual({ topConstraints: { minRestHours: { from: 8, to: 6 } }, tradeOffs: {} });
    expect(savedInteractions).toHaveLength(1);
    expect(writebackClient.submitScheduleExplanation).not.toHaveBeenCalled();
    // Still audited - degraded is a real, disclosed outcome, not skipped bookkeeping.
    expect(auditClient.recordEvent).toHaveBeenCalled();
  });

  it('enters degraded mode when the tenant has not configured a BYOK provider yet', async () => {
    schedulingClient.getScheduleJobForExplanation.mockResolvedValue(foundJob());
    aiProviderConfig.resolveForCall.mockRejectedValue(new AiProviderNotConfiguredError(TENANT_A));
    const { dataSource } = buildDataSource();
    const service = buildService(dataSource);

    const result = await service.explainSchedule(TENANT_A, null, JOB_ID);

    expect(result.degradedMode).toBe(true);
    expect(llmClient.complete).not.toHaveBeenCalled();
  });
});
