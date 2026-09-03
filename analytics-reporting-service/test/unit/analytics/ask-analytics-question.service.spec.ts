import { AskAnalyticsQuestionService } from '../../../src/analytics/ask-analytics-question.service';
import { ExecutiveSummaryPeriod } from '../../../src/analytics/metric-query-engine.service';
import { MetricCategory } from '../../../src/analytics/entities/metric-definition.entity';

/**
 * ADR-0111/ADR-0165: this orchestration is tested against a **mock**
 * `NlQueryBridgeClient` that simulates a working Module 10 - proving
 * `AskAnalyticsQuestionService`'s own logic is correct and ready
 * independent of whether the real implementation (`GrpcNlQueryBridgeClient`)
 * is reachable. `GrpcNlQueryBridgeClient`/`AiLayerGrpcClientService` have
 * their own separate specs.
 */
describe('AskAnalyticsQuestionService', () => {
  let bridgeClient: { translateQuestion: jest.Mock; generateAnswer: jest.Mock };
  let metricQueryEngine: { query: jest.Mock; executiveSummary: jest.Mock };
  let metricDefinitions: { listVisibleMetrics: jest.Mock };
  let service: AskAnalyticsQuestionService;

  const tenantId = 'tenant-1';
  const userId = 'user-1';
  const fakeResults = [
    {
      metric: 'adherence_trend',
      value: 95,
      trend: null,
      comparisonPeriodValue: null,
      periodStart: new Date(),
      periodEnd: new Date(),
      dataAsOf: null,
    },
  ];

  beforeEach(() => {
    bridgeClient = { translateQuestion: jest.fn(), generateAnswer: jest.fn() };
    metricQueryEngine = { query: jest.fn(), executiveSummary: jest.fn() };
    metricDefinitions = {
      listVisibleMetrics: jest.fn().mockResolvedValue([
        { name: 'adherence_trend', category: MetricCategory.PERFORMANCE },
        { name: 'forecast_accuracy_mape', category: MetricCategory.FORECAST_ACCURACY },
      ]),
    };
    service = new AskAnalyticsQuestionService(bridgeClient as any, metricQueryEngine as any, metricDefinitions as any);
  });

  it("passes the tenant's real, visible metric catalog to translateQuestion", async () => {
    bridgeClient.translateQuestion.mockResolvedValueOnce({
      kind: 'metricQuery',
      metricName: 'adherence_trend',
      filter: { limit: 3 },
    });
    metricQueryEngine.query.mockResolvedValueOnce(fakeResults);
    bridgeClient.generateAnswer.mockResolvedValueOnce('Adherence is trending well.');

    await service.ask(tenantId, userId, 'How is adherence trending?');

    expect(metricDefinitions.listVisibleMetrics).toHaveBeenCalledWith(tenantId);
    expect(bridgeClient.translateQuestion).toHaveBeenCalledWith(tenantId, userId, 'How is adherence trending?', [
      'adherence_trend',
      'forecast_accuracy_mape',
    ]);
  });

  it('executes via MetricQueryEngineService.query when Module 10 resolves the question to a metricQuery shape', async () => {
    bridgeClient.translateQuestion.mockResolvedValueOnce({
      kind: 'metricQuery',
      metricName: 'adherence_trend',
      filter: { limit: 3 },
    });
    metricQueryEngine.query.mockResolvedValueOnce(fakeResults);
    bridgeClient.generateAnswer.mockResolvedValueOnce('Adherence is trending well.');

    const answer = await service.ask(tenantId, userId, 'How is adherence trending?');

    expect(metricQueryEngine.query).toHaveBeenCalledWith(tenantId, 'adherence_trend', { limit: 3 });
    expect(metricQueryEngine.executiveSummary).not.toHaveBeenCalled();
    expect(bridgeClient.generateAnswer).toHaveBeenCalledWith(
      tenantId,
      userId,
      'How is adherence trending?',
      fakeResults,
    );
    expect(answer).toEqual({
      question: 'How is adherence trending?',
      answerText: 'Adherence is trending well.',
      results: fakeResults,
    });
  });

  it('executes via MetricQueryEngineService.executiveSummary when Module 10 resolves the question to an executiveSummary shape', async () => {
    bridgeClient.translateQuestion.mockResolvedValueOnce({
      kind: 'executiveSummary',
      orgUnitId: 'org-1',
      period: ExecutiveSummaryPeriod.CURRENT_MONTH,
    });
    metricQueryEngine.executiveSummary.mockResolvedValueOnce(fakeResults);
    bridgeClient.generateAnswer.mockResolvedValueOnce('Here is your executive summary.');

    await service.ask(tenantId, userId, 'Give me an executive summary for this site.');

    expect(metricQueryEngine.executiveSummary).toHaveBeenCalledWith(
      tenantId,
      'org-1',
      ExecutiveSummaryPeriod.CURRENT_MONTH,
    );
    expect(metricQueryEngine.query).not.toHaveBeenCalled();
  });

  it('propagates a translateQuestion failure (e.g. NlQueryBridgeUnavailableError) without ever calling the query engine or generateAnswer', async () => {
    bridgeClient.translateQuestion.mockRejectedValueOnce(new Error('bridge unavailable'));

    await expect(service.ask(tenantId, userId, 'anything')).rejects.toThrow('bridge unavailable');
    expect(metricQueryEngine.query).not.toHaveBeenCalled();
    expect(metricQueryEngine.executiveSummary).not.toHaveBeenCalled();
    expect(bridgeClient.generateAnswer).not.toHaveBeenCalled();
  });

  it('propagates a query-execution failure without calling generateAnswer', async () => {
    bridgeClient.translateQuestion.mockResolvedValueOnce({ kind: 'metricQuery', metricName: 'unknown' });
    metricQueryEngine.query.mockRejectedValueOnce(new Error('metric not found'));

    await expect(service.ask(tenantId, userId, 'anything')).rejects.toThrow('metric not found');
    expect(bridgeClient.generateAnswer).not.toHaveBeenCalled();
  });

  it('accepts a null userId (e.g. no authenticated actor) and passes it through unchanged', async () => {
    bridgeClient.translateQuestion.mockResolvedValueOnce({ kind: 'metricQuery', metricName: 'adherence_trend' });
    metricQueryEngine.query.mockResolvedValueOnce(fakeResults);
    bridgeClient.generateAnswer.mockResolvedValueOnce('Answer.');

    await service.ask(tenantId, null, 'anything');

    expect(bridgeClient.translateQuestion).toHaveBeenCalledWith(tenantId, null, 'anything', expect.any(Array));
    expect(bridgeClient.generateAnswer).toHaveBeenCalledWith(tenantId, null, 'anything', fakeResults);
  });
});
