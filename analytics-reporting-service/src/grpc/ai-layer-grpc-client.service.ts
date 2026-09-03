import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, Observable, timeout } from 'rxjs';
import { AI_LAYER_GRPC_PACKAGE } from './ai-layer-grpc-client.constants';

export interface TranslateQuestionGrpcRequest {
  tenantId: string;
  userId: string;
  question: string;
  availableMetricNames: string[];
}

export interface TranslateQuestionGrpcResponse {
  errorCode: string;
  retryAfterSeconds: number;
  kind: string;
  metricName: string;
  filterJson: string;
  orgUnitId: string;
  period: string;
}

export interface GenerateAnswerGrpcRequest {
  tenantId: string;
  userId: string;
  question: string;
  resultsJson: string;
}

export interface GenerateAnswerGrpcResponse {
  errorCode: string;
  retryAfterSeconds: number;
  answerText: string;
}

interface NlQueryBridgeServiceClient {
  translateQuestion(request: TranslateQuestionGrpcRequest): Observable<TranslateQuestionGrpcResponse>;
  generateAnswer(request: GenerateAnswerGrpcRequest): Observable<GenerateAnswerGrpcResponse>;
}

const CALL_TIMEOUT_MS = 20_000; // Module 10's own LLM call timeout (CALL_TIMEOUT_MS, provider-routing-llm-client.service.ts) plus headroom for its own processing.

export class AiLayerGrpcClientUnavailableError extends Error {
  constructor(method: string, cause: unknown) {
    super(`NlQueryBridgeService.${method} unavailable: ${(cause as Error).message}`);
    this.name = 'AiLayerGrpcClientUnavailableError';
  }
}

/**
 * ADR-0165: this service's first gRPC client - the raw transport wrapper
 * around Module 10's `NlQueryBridgeService`, own copy of every other
 * service's identical `*GrpcClientService` shape (e.g.
 * adherence-compliance-service's `EmployeeGrpcClientService`). Returns the
 * response message as-is (including its own `errorCode` field) - mapping
 * that into `NlQueryBridgeClient`'s typed contract/errors is
 * `GrpcNlQueryBridgeClient`'s job, not this transport layer's.
 * `AiLayerGrpcClientUnavailableError` is reserved for a real transport
 * failure (network/timeout) - a business-level `errorCode` in a
 * successfully-received response is not a transport error.
 */
@Injectable()
export class AiLayerGrpcClientService implements OnModuleInit {
  private client!: NlQueryBridgeServiceClient;

  constructor(@Inject(AI_LAYER_GRPC_PACKAGE) private readonly grpcClient: ClientGrpc) {}

  onModuleInit(): void {
    this.client = this.grpcClient.getService<NlQueryBridgeServiceClient>('NlQueryBridgeService');
  }

  async translateQuestion(request: TranslateQuestionGrpcRequest): Promise<TranslateQuestionGrpcResponse> {
    try {
      return await firstValueFrom(this.client.translateQuestion(request).pipe(timeout(CALL_TIMEOUT_MS)));
    } catch (err) {
      throw new AiLayerGrpcClientUnavailableError('TranslateQuestion', err);
    }
  }

  async generateAnswer(request: GenerateAnswerGrpcRequest): Promise<GenerateAnswerGrpcResponse> {
    try {
      return await firstValueFrom(this.client.generateAnswer(request).pipe(timeout(CALL_TIMEOUT_MS)));
    } catch (err) {
      throw new AiLayerGrpcClientUnavailableError('GenerateAnswer', err);
    }
  }
}
