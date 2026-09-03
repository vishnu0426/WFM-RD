import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, Observable, timeout } from 'rxjs';
import { FORECASTING_GRPC_PACKAGE } from './forecasting-grpc-client.constants';
import { DomainError } from '../common/errors/domain-error';

export interface GetForecastRunForExplanationRequest {
  tenantId: string;
  forecastRunId: string;
}

export interface ForecastAccuracyEntry {
  evaluatedAt: string;
  actualVolume: string;
  predictedVolume: string;
  mape: string;
  bias: string;
}

export interface ForecastRunForExplanation {
  found: boolean;
  tenantId: string;
  orgUnitId: string;
  status: string;
  dateRangeStart: string;
  dateRangeEnd: string;
  intervalMinutes: number;
  isColdStart: boolean;
  completedAt: string;
  hasModel: boolean;
  modelType: string;
  modelStatus: string;
  backtestMape: string;
  backtestWfa: string;
  minimumDataVolumeMet: boolean;
  accuracyLog: ForecastAccuracyEntry[];
}

interface ForecastExplanationDataServiceClient {
  getForecastRunForExplanation(request: GetForecastRunForExplanationRequest): Observable<ForecastRunForExplanation>;
}

/** Own copy of every other cross-service gRPC client's budget/rationale - no reason for this call to wait longer than any other. */
const CALL_TIMEOUT_MS = 3000;

export class ForecastingGrpcClientUnavailableError extends DomainError {
  constructor(cause: unknown) {
    super(
      'FORECASTING_SERVICE_UNAVAILABLE',
      `ForecastExplanationDataService.GetForecastRunForExplanation unavailable: ${(cause as Error).message}`,
    );
  }
}

/** Phase 4 (docs/adr/0119): thin wrapper over `ForecastExplanationDataService.GetForecastRunForExplanation` - the raw structured data `ForecastExplanationService` translates into an LLM prompt. */
@Injectable()
export class ForecastingGrpcClientService implements OnModuleInit {
  private client!: ForecastExplanationDataServiceClient;

  constructor(@Inject(FORECASTING_GRPC_PACKAGE) private readonly grpcClient: ClientGrpc) {}

  onModuleInit(): void {
    this.client = this.grpcClient.getService<ForecastExplanationDataServiceClient>('ForecastExplanationDataService');
  }

  async getForecastRunForExplanation(tenantId: string, forecastRunId: string): Promise<ForecastRunForExplanation> {
    try {
      return await firstValueFrom(
        this.client.getForecastRunForExplanation({ tenantId, forecastRunId }).pipe(timeout(CALL_TIMEOUT_MS)),
      );
    } catch (err) {
      throw new ForecastingGrpcClientUnavailableError(err);
    }
  }
}
