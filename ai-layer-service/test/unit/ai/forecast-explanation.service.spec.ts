import { DataSource, EntityManager } from 'typeorm';
import { ForecastExplanationService } from '../../../src/ai/forecast-explanation.service';
import { ForecastingGrpcClientService } from '../../../src/grpc/forecasting-grpc-client.service';
import { TenantScopeAssertionService } from '../../../src/ai/tenant-scope-assertion.service';
import { LlmClient } from '../../../src/ai/llm/llm-client';
import { AiProviderConfigService } from '../../../src/ai/ai-provider-config.service';
import { AuditGrpcClientService } from '../../../src/grpc/audit-grpc-client.service';
import { MetricsService } from '../../../src/common/metrics/metrics.service';
import { ForecastRunNotFoundError } from '../../../src/ai/errors/forecast-run-not-found.error';
import { CrossTenantDataAssemblyError } from '../../../src/common/tenant/tenant-context.errors';
import { LlmCallFailedError } from '../../../src/ai/llm/llm-call-failed.error';
import { AiLlmProvider } from '../../../src/ai/entities/ai-provider-config.entity';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const RUN_ID = '33333333-3333-3333-3333-333333333333';

function foundRun(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    found: true,
    tenantId: TENANT_A,
    orgUnitId: 'org-1',
    status: 'completed',
    dateRangeStart: '2026-01-01',
    dateRangeEnd: '2026-01-07',
    intervalMinutes: 30,
    isColdStart: false,
    completedAt: '2026-01-07T00:00:00Z',
    hasModel: true,
    modelType: 'prophet',
    modelStatus: 'active',
    backtestMape: '0.123456',
    backtestWfa: '0.900000',
    minimumDataVolumeMet: true,
    accuracyLog: [
      { evaluatedAt: '2026-01-07T00:00:00Z', actualVolume: '110', predictedVolume: '100', mape: '0.1', bias: '-0.1' },
    ],
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

describe('ForecastExplanationService', () => {
  let forecastingClient: { getForecastRunForExplanation: jest.Mock };
  let llmClient: { complete: jest.Mock };
  let aiProviderConfig: { resolveForCall: jest.Mock };
  let auditClient: { recordEvent: jest.Mock };
  let metrics: MetricsService;

  function buildService(dataSource: DataSource) {
    return new ForecastExplanationService(
      dataSource,
      forecastingClient as unknown as ForecastingGrpcClientService,
      new TenantScopeAssertionService(metrics, auditClient as unknown as AuditGrpcClientService),
      llmClient as unknown as LlmClient,
      aiProviderConfig as unknown as AiProviderConfigService,
      auditClient as unknown as AuditGrpcClientService,
      metrics,
    );
  }

  beforeEach(() => {
    forecastingClient = { getForecastRunForExplanation: jest.fn() };
    llmClient = { complete: jest.fn() };
    aiProviderConfig = { resolveForCall: jest.fn() };
    auditClient = { recordEvent: jest.fn().mockResolvedValue(undefined) };
    metrics = new MetricsService();
    metrics.onModuleInit();
  });

  it('throws ForecastRunNotFoundError when not found', async () => {
    forecastingClient.getForecastRunForExplanation.mockResolvedValue({ found: false });
    const { dataSource } = buildDataSource();
    const service = buildService(dataSource);

    await expect(service.explainForecast(TENANT_A, null, RUN_ID)).rejects.toThrow(ForecastRunNotFoundError);
  });

  it('rejects before any LLM call when scoped to a different tenant', async () => {
    forecastingClient.getForecastRunForExplanation.mockResolvedValue(foundRun({ tenantId: 'other-tenant' }));
    const { dataSource } = buildDataSource();
    const service = buildService(dataSource);

    await expect(service.explainForecast(TENANT_A, null, RUN_ID)).rejects.toThrow(CrossTenantDataAssemblyError);
    expect(llmClient.complete).not.toHaveBeenCalled();
  });

  it('persists a real AIInteraction with model/accuracy data on the happy path', async () => {
    forecastingClient.getForecastRunForExplanation.mockResolvedValue(foundRun());
    aiProviderConfig.resolveForCall.mockResolvedValue({ provider: AiLlmProvider.ANTHROPIC, model: 'm', apiKey: 'k' });
    llmClient.complete.mockResolvedValue({
      model: 'm',
      text: JSON.stringify({
        summaryText: 'This forecast used a prophet model with 12% backtest MAPE.',
        topConstraints: { modelType: 'prophet' },
        tradeOffs: {},
        selfReportedConfidence: 0.8,
      }),
    });
    const { dataSource, savedInteractions } = buildDataSource();
    const service = buildService(dataSource);

    const result = await service.explainForecast(TENANT_A, null, RUN_ID);

    expect(result.degradedMode).toBe(false);
    expect(result.outputText).toContain('prophet model');
    expect(savedInteractions).toHaveLength(1);
    expect(auditClient.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ai.forecast_explanation.generated' }),
    );
  });

  it('enters degraded mode when the LLM call fails', async () => {
    forecastingClient.getForecastRunForExplanation.mockResolvedValue(foundRun());
    aiProviderConfig.resolveForCall.mockResolvedValue({ provider: AiLlmProvider.OPENAI, model: 'm', apiKey: 'k' });
    llmClient.complete.mockRejectedValue(new LlmCallFailedError(new Error('unreachable')));
    const { dataSource } = buildDataSource();
    const service = buildService(dataSource);

    const result = await service.explainForecast(TENANT_A, null, RUN_ID);

    expect(result.degradedMode).toBe(true);
    expect(result.outputText).toBeNull();
  });

  it('reports has_model: false as a null model, not a synthetic value', async () => {
    forecastingClient.getForecastRunForExplanation.mockResolvedValue(
      foundRun({ hasModel: false, modelType: '', modelStatus: '', backtestMape: '', backtestWfa: '' }),
    );
    aiProviderConfig.resolveForCall.mockResolvedValue({ provider: AiLlmProvider.ANTHROPIC, model: 'm', apiKey: 'k' });
    llmClient.complete.mockResolvedValue({ model: 'm', text: JSON.stringify({ summaryText: 'no model linked yet' }) });
    const { dataSource } = buildDataSource();
    const service = buildService(dataSource);

    const result = await service.explainForecast(TENANT_A, null, RUN_ID);

    expect((result.inputContext as Record<string, unknown>).model).toBeNull();
  });
});
