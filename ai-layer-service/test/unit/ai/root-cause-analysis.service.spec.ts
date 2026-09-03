import { DataSource, EntityManager } from 'typeorm';
import { RootCauseAnalysisService } from '../../../src/ai/root-cause-analysis.service';
import { ComplianceGrpcClientService } from '../../../src/grpc/compliance-grpc-client.service';
import { IntradayGrpcClientService } from '../../../src/grpc/intraday-grpc-client.service';
import { TenantScopeAssertionService } from '../../../src/ai/tenant-scope-assertion.service';
import { LlmClient } from '../../../src/ai/llm/llm-client';
import { AiProviderConfigService } from '../../../src/ai/ai-provider-config.service';
import { AuditGrpcClientService } from '../../../src/grpc/audit-grpc-client.service';
import { MetricsService } from '../../../src/common/metrics/metrics.service';
import { RootCauseAnalysisNoDataError } from '../../../src/ai/errors/root-cause-analysis-no-data.error';
import { CrossTenantDataAssemblyError } from '../../../src/common/tenant/tenant-context.errors';
import { AiLlmProvider } from '../../../src/ai/entities/ai-provider-config.entity';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const ORG_UNIT_ID = 'org-1';

const NOT_FOUND_ADHERENCE = {
  found: false,
  tenantId: '',
  employeeCount: 0,
  scoredEmployeeCount: 0,
  periodCount: 0,
  averageAdherencePct: '',
  totalMajorDeviationCount: 0,
  minAdherencePct: '',
  maxAdherencePct: '',
};

const EMPTY_REALLOCATIONS = { reallocations: [], totalMatchedBeforeCap: 0 };

function foundAdherence(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    found: true,
    tenantId: TENANT_A,
    employeeCount: 5,
    scoredEmployeeCount: 4,
    periodCount: 20,
    averageAdherencePct: '82.00',
    totalMajorDeviationCount: 6,
    minAdherencePct: '60.00',
    maxAdherencePct: '99.00',
    ...overrides,
  };
}

function buildDataSource() {
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

describe('RootCauseAnalysisService', () => {
  let complianceClient: { getOrgUnitAdherenceSummary: jest.Mock };
  let intradayClient: { listReallocationsForPeriod: jest.Mock };
  let llmClient: { complete: jest.Mock };
  let aiProviderConfig: { resolveForCall: jest.Mock };
  let auditClient: { recordEvent: jest.Mock };
  let metrics: MetricsService;

  function buildService(dataSource: DataSource) {
    return new RootCauseAnalysisService(
      dataSource,
      complianceClient as unknown as ComplianceGrpcClientService,
      intradayClient as unknown as IntradayGrpcClientService,
      new TenantScopeAssertionService(metrics, auditClient as unknown as AuditGrpcClientService),
      llmClient as unknown as LlmClient,
      aiProviderConfig as unknown as AiProviderConfigService,
      auditClient as unknown as AuditGrpcClientService,
      metrics,
    );
  }

  beforeEach(() => {
    complianceClient = { getOrgUnitAdherenceSummary: jest.fn() };
    intradayClient = { listReallocationsForPeriod: jest.fn() };
    llmClient = { complete: jest.fn() };
    aiProviderConfig = { resolveForCall: jest.fn() };
    auditClient = { recordEvent: jest.fn().mockResolvedValue(undefined) };
    metrics = new MetricsService();
    metrics.onModuleInit();
  });

  it('throws RootCauseAnalysisNoDataError when both sources have nothing', async () => {
    complianceClient.getOrgUnitAdherenceSummary.mockResolvedValue(NOT_FOUND_ADHERENCE);
    intradayClient.listReallocationsForPeriod.mockResolvedValue(EMPTY_REALLOCATIONS);
    const { dataSource } = buildDataSource();
    const service = buildService(dataSource);

    await expect(
      service.analyzeRootCause(TENANT_A, null, ORG_UNIT_ID, new Date('2026-01-01'), new Date('2026-01-08')),
    ).rejects.toThrow(RootCauseAnalysisNoDataError);
  });

  it('proceeds when only the reallocation source has data (adherence legitimately not found)', async () => {
    complianceClient.getOrgUnitAdherenceSummary.mockResolvedValue(NOT_FOUND_ADHERENCE);
    intradayClient.listReallocationsForPeriod.mockResolvedValue({
      reallocations: [
        { id: 'r1', fromQueueId: 'q1', toQueueId: 'q2', status: 'executed', reason: 'r', createdAt: 'x' },
      ],
      totalMatchedBeforeCap: 1,
    });
    aiProviderConfig.resolveForCall.mockResolvedValue({ provider: AiLlmProvider.ANTHROPIC, model: 'm', apiKey: 'k' });
    llmClient.complete.mockResolvedValue({
      model: 'm',
      text: JSON.stringify({ summaryText: 'No adherence data, one reallocation occurred.' }),
    });
    const { dataSource } = buildDataSource();
    const service = buildService(dataSource);

    const result = await service.analyzeRootCause(
      TENANT_A,
      null,
      ORG_UNIT_ID,
      new Date('2026-01-01'),
      new Date('2026-01-08'),
    );

    expect((result.inputContext as Record<string, unknown>).adherence).toBeNull();
    expect(result.degradedMode).toBe(false);
  });

  it('rejects before any LLM call when the adherence source is scoped to a different tenant', async () => {
    complianceClient.getOrgUnitAdherenceSummary.mockResolvedValue(foundAdherence({ tenantId: 'other-tenant' }));
    intradayClient.listReallocationsForPeriod.mockResolvedValue(EMPTY_REALLOCATIONS);
    const { dataSource } = buildDataSource();
    const service = buildService(dataSource);

    await expect(
      service.analyzeRootCause(TENANT_A, null, ORG_UNIT_ID, new Date('2026-01-01'), new Date('2026-01-08')),
    ).rejects.toThrow(CrossTenantDataAssemblyError);
    expect(llmClient.complete).not.toHaveBeenCalled();
  });

  it('combines both real sources into one input_context on the happy path, and audits', async () => {
    complianceClient.getOrgUnitAdherenceSummary.mockResolvedValue(foundAdherence());
    intradayClient.listReallocationsForPeriod.mockResolvedValue({
      reallocations: [
        { id: 'r1', fromQueueId: 'q1', toQueueId: 'q2', status: 'executed', reason: 'r', createdAt: 'x' },
      ],
      totalMatchedBeforeCap: 1,
    });
    aiProviderConfig.resolveForCall.mockResolvedValue({ provider: AiLlmProvider.ANTHROPIC, model: 'm', apiKey: 'k' });
    llmClient.complete.mockResolvedValue({
      model: 'm',
      text: JSON.stringify({
        summaryText: 'Adherence dipped alongside one reallocation in the window.',
        selfReportedConfidence: 0.4,
      }),
    });
    const { dataSource, savedInteractions } = buildDataSource();
    const service = buildService(dataSource);

    const result = await service.analyzeRootCause(
      TENANT_A,
      null,
      ORG_UNIT_ID,
      new Date('2026-01-01'),
      new Date('2026-01-08'),
    );

    const context = result.inputContext as Record<string, unknown>;
    expect(context.adherence).toEqual(
      expect.objectContaining({ averageAdherencePct: '82.00', totalMajorDeviationCount: 6 }),
    );
    expect((context.reallocations as Record<string, unknown>).count).toBe(1);
    expect(savedInteractions).toHaveLength(1);
    expect(auditClient.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ai.root_cause_analysis.generated', resourceId: ORG_UNIT_ID }),
    );
  });

  it('enters degraded mode when no BYOK provider is configured, still returning both sources raw', async () => {
    complianceClient.getOrgUnitAdherenceSummary.mockResolvedValue(foundAdherence());
    intradayClient.listReallocationsForPeriod.mockResolvedValue(EMPTY_REALLOCATIONS);
    const { AiProviderNotConfiguredError } = jest.requireActual(
      '../../../src/ai/errors/ai-provider-not-configured.error',
    );
    aiProviderConfig.resolveForCall.mockRejectedValue(new AiProviderNotConfiguredError(TENANT_A));
    const { dataSource } = buildDataSource();
    const service = buildService(dataSource);

    const result = await service.analyzeRootCause(
      TENANT_A,
      null,
      ORG_UNIT_ID,
      new Date('2026-01-01'),
      new Date('2026-01-08'),
    );

    expect(result.degradedMode).toBe(true);
    expect(llmClient.complete).not.toHaveBeenCalled();
  });
});
