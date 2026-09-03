import { of, throwError } from 'rxjs';
import { ClientGrpc } from '@nestjs/microservices';
import {
  AiLayerGrpcClientService,
  AiLayerGrpcClientUnavailableError,
} from '../../../src/grpc/ai-layer-grpc-client.service';

describe('AiLayerGrpcClientService', () => {
  let translateQuestion: jest.Mock;
  let generateAnswer: jest.Mock;
  let grpcClient: jest.Mocked<Pick<ClientGrpc, 'getService'>>;
  let service: AiLayerGrpcClientService;

  beforeEach(() => {
    translateQuestion = jest.fn();
    generateAnswer = jest.fn();
    grpcClient = { getService: jest.fn().mockReturnValue({ translateQuestion, generateAnswer }) };
    service = new AiLayerGrpcClientService(grpcClient as unknown as ClientGrpc);
    service.onModuleInit();
  });

  describe('translateQuestion', () => {
    it('returns the raw response message, including its own errorCode field', async () => {
      const response = {
        errorCode: '',
        retryAfterSeconds: 0,
        kind: 'metric_query',
        metricName: 'adherence_trend',
        filterJson: '',
        orgUnitId: '',
        period: '',
      };
      translateQuestion.mockReturnValue(of(response));

      const result = await service.translateQuestion({
        tenantId: 'tenant-1',
        userId: 'user-1',
        question: 'q',
        availableMetricNames: [],
      });

      expect(result).toEqual(response);
    });

    it('wraps a transport failure in AiLayerGrpcClientUnavailableError, naming the RPC', async () => {
      translateQuestion.mockReturnValue(throwError(() => new Error('UNAVAILABLE')));
      await expect(
        service.translateQuestion({ tenantId: 'tenant-1', userId: '', question: 'q', availableMetricNames: [] }),
      ).rejects.toThrow(AiLayerGrpcClientUnavailableError);
      await expect(
        service.translateQuestion({ tenantId: 'tenant-1', userId: '', question: 'q', availableMetricNames: [] }),
      ).rejects.toThrow('TranslateQuestion');
    });
  });

  describe('generateAnswer', () => {
    it('returns the raw response message', async () => {
      const response = { errorCode: '', retryAfterSeconds: 0, answerText: 'Answer.' };
      generateAnswer.mockReturnValue(of(response));

      const result = await service.generateAnswer({
        tenantId: 'tenant-1',
        userId: '',
        question: 'q',
        resultsJson: '[]',
      });

      expect(result).toEqual(response);
    });

    it('wraps a transport failure in AiLayerGrpcClientUnavailableError, naming the RPC', async () => {
      generateAnswer.mockReturnValue(throwError(() => new Error('UNAVAILABLE')));
      await expect(
        service.generateAnswer({ tenantId: 'tenant-1', userId: '', question: 'q', resultsJson: '[]' }),
      ).rejects.toThrow('GenerateAnswer');
    });
  });
});
