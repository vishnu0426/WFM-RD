import { GrpcNlQueryBridgeClient } from '../../../../src/analytics/nl-query-bridge/grpc-nl-query-bridge-client';
import {
  AiLayerGrpcClientService,
  AiLayerGrpcClientUnavailableError,
} from '../../../../src/grpc/ai-layer-grpc-client.service';
import { NlQueryBridgeUnavailableError } from '../../../../src/analytics/errors/nl-query-bridge-unavailable.error';
import { NlQueryBridgeRateLimitedError } from '../../../../src/analytics/errors/nl-query-bridge-rate-limited.error';
import { AnalyticsQuestionTooLongError } from '../../../../src/analytics/errors/analytics-question-too-long.error';
import { ExecutiveSummaryPeriod } from '../../../../src/analytics/metric-query-engine.service';

describe('GrpcNlQueryBridgeClient', () => {
  let grpcClient: { translateQuestion: jest.Mock; generateAnswer: jest.Mock };
  let client: GrpcNlQueryBridgeClient;

  beforeEach(() => {
    grpcClient = { translateQuestion: jest.fn(), generateAnswer: jest.fn() };
    client = new GrpcNlQueryBridgeClient(grpcClient as unknown as AiLayerGrpcClientService);
  });

  describe('translateQuestion', () => {
    it('maps a successful metric_query response to StructuredAnalyticsQuery', async () => {
      grpcClient.translateQuestion.mockResolvedValueOnce({
        errorCode: '',
        retryAfterSeconds: 0,
        kind: 'metric_query',
        metricName: 'adherence_trend',
        filterJson: '',
        orgUnitId: '',
        period: '',
      });

      const result = await client.translateQuestion('tenant-1', 'user-1', 'How is adherence trending?', [
        'adherence_trend',
      ]);

      expect(result).toEqual({ kind: 'metricQuery', metricName: 'adherence_trend', filter: undefined });
      expect(grpcClient.translateQuestion).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        userId: 'user-1',
        question: 'How is adherence trending?',
        availableMetricNames: ['adherence_trend'],
      });
    });

    it('sends an empty userId when none was supplied, never "null" or "undefined" over the wire', async () => {
      grpcClient.translateQuestion.mockResolvedValueOnce({
        errorCode: '',
        retryAfterSeconds: 0,
        kind: 'metric_query',
        metricName: 'adherence_trend',
        filterJson: '',
        orgUnitId: '',
        period: '',
      });

      await client.translateQuestion('tenant-1', null, 'question', ['adherence_trend']);

      expect(grpcClient.translateQuestion).toHaveBeenCalledWith(expect.objectContaining({ userId: '' }));
    });

    it('maps a successful executive_summary response, including an optional orgUnitId', async () => {
      grpcClient.translateQuestion.mockResolvedValueOnce({
        errorCode: '',
        retryAfterSeconds: 0,
        kind: 'executive_summary',
        metricName: '',
        filterJson: '',
        orgUnitId: 'org-1',
        period: 'last_month',
      });

      const result = await client.translateQuestion('tenant-1', 'user-1', 'summary please', []);

      expect(result).toEqual({
        kind: 'executiveSummary',
        orgUnitId: 'org-1',
        period: ExecutiveSummaryPeriod.LAST_MONTH,
      });
    });

    it('maps errorCode "RATE_LIMITED" to NlQueryBridgeRateLimitedError, carrying retryAfterSeconds', async () => {
      grpcClient.translateQuestion.mockResolvedValue({ errorCode: 'RATE_LIMITED', retryAfterSeconds: 42 });

      await expect(client.translateQuestion('tenant-1', 'user-1', 'q', [])).rejects.toThrow(
        NlQueryBridgeRateLimitedError,
      );
      try {
        await client.translateQuestion('tenant-1', 'user-1', 'q', []);
        fail('expected translateQuestion to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(NlQueryBridgeRateLimitedError);
        expect((err as NlQueryBridgeRateLimitedError).retryAfterSeconds).toBe(42);
      }
    });

    it('maps errorCode "QUESTION_TOO_LONG" to AnalyticsQuestionTooLongError', async () => {
      grpcClient.translateQuestion.mockResolvedValueOnce({ errorCode: 'QUESTION_TOO_LONG', retryAfterSeconds: 0 });

      await expect(client.translateQuestion('tenant-1', 'user-1', 'q'.repeat(4001), [])).rejects.toThrow(
        AnalyticsQuestionTooLongError,
      );
    });

    it('maps errorCode "UNAVAILABLE" (and any other unrecognized code) to NlQueryBridgeUnavailableError', async () => {
      grpcClient.translateQuestion.mockResolvedValueOnce({ errorCode: 'UNAVAILABLE', retryAfterSeconds: 0 });

      await expect(client.translateQuestion('tenant-1', 'user-1', 'q', [])).rejects.toThrow(
        NlQueryBridgeUnavailableError,
      );
    });

    it('maps a real transport failure (AiLayerGrpcClientUnavailableError) to the same typed unavailable error', async () => {
      grpcClient.translateQuestion.mockRejectedValueOnce(
        new AiLayerGrpcClientUnavailableError('TranslateQuestion', new Error('connection refused')),
      );

      await expect(client.translateQuestion('tenant-1', 'user-1', 'q', [])).rejects.toThrow(
        NlQueryBridgeUnavailableError,
      );
    });
  });

  describe('generateAnswer', () => {
    it('serializes results to JSON and returns answerText on success', async () => {
      grpcClient.generateAnswer.mockResolvedValueOnce({
        errorCode: '',
        retryAfterSeconds: 0,
        answerText: 'Adherence rose to 91%.',
      });

      const answer = await client.generateAnswer('tenant-1', 'user-1', 'question', [{ metric: 'adherence_trend' }]);

      expect(answer).toBe('Adherence rose to 91%.');
      expect(grpcClient.generateAnswer).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        userId: 'user-1',
        question: 'question',
        resultsJson: JSON.stringify([{ metric: 'adherence_trend' }]),
      });
    });

    it('maps errorCode "UNAVAILABLE" to NlQueryBridgeUnavailableError', async () => {
      grpcClient.generateAnswer.mockResolvedValueOnce({ errorCode: 'UNAVAILABLE', retryAfterSeconds: 0 });

      await expect(client.generateAnswer('tenant-1', 'user-1', 'question', [])).rejects.toThrow(
        NlQueryBridgeUnavailableError,
      );
    });
  });
});
