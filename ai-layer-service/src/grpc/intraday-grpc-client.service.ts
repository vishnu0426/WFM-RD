import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, Observable, timeout } from 'rxjs';
import { INTRADAY_GRPC_PACKAGE } from './intraday-grpc-client.constants';
import { DomainError } from '../common/errors/domain-error';

export interface GetReallocationForExplanationRequest {
  tenantId: string;
  reallocationActionId: string;
}

export interface ReallocationForExplanation {
  found: boolean;
  tenantId: string;
  triggeredBy: string;
  fromQueueId: string;
  toQueueId: string;
  affectedEmployeeIds: string[];
  reason: string;
  status: string;
  aiRationaleJson: string;
  createdAt: string;
  executedAt: string;
}

export interface ListReallocationsForPeriodRequest {
  tenantId: string;
  periodStart: string;
  periodEnd: string;
}

export interface ReallocationSummary {
  id: string;
  fromQueueId: string;
  toQueueId: string;
  status: string;
  reason: string;
  createdAt: string;
}

export interface ReallocationsForPeriod {
  reallocations: ReallocationSummary[];
  totalMatchedBeforeCap: number;
}

interface ReallocationServiceClient {
  getReallocationForExplanation(request: GetReallocationForExplanationRequest): Observable<ReallocationForExplanation>;
  listReallocationsForPeriod(request: ListReallocationsForPeriodRequest): Observable<ReallocationsForPeriod>;
}

/** Own copy of every other cross-service gRPC client's budget/rationale - no reason for this call to wait longer than any other. */
const CALL_TIMEOUT_MS = 3000;

export class IntradayGrpcClientUnavailableError extends DomainError {
  constructor(cause: unknown) {
    super('INTRADAY_SERVICE_UNAVAILABLE', `ReallocationService call unavailable: ${(cause as Error).message}`);
  }
}

/** Phase 4 (docs/adr/0120/0122): thin wrapper over `ReallocationService`'s two RPCs. */
@Injectable()
export class IntradayGrpcClientService implements OnModuleInit {
  private client!: ReallocationServiceClient;

  constructor(@Inject(INTRADAY_GRPC_PACKAGE) private readonly grpcClient: ClientGrpc) {}

  onModuleInit(): void {
    this.client = this.grpcClient.getService<ReallocationServiceClient>('ReallocationService');
  }

  async getReallocationForExplanation(
    tenantId: string,
    reallocationActionId: string,
  ): Promise<ReallocationForExplanation> {
    try {
      return await firstValueFrom(
        this.client.getReallocationForExplanation({ tenantId, reallocationActionId }).pipe(timeout(CALL_TIMEOUT_MS)),
      );
    } catch (err) {
      throw new IntradayGrpcClientUnavailableError(err);
    }
  }

  async listReallocationsForPeriod(
    tenantId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<ReallocationsForPeriod> {
    try {
      return await firstValueFrom(
        this.client.listReallocationsForPeriod({ tenantId, periodStart, periodEnd }).pipe(timeout(CALL_TIMEOUT_MS)),
      );
    } catch (err) {
      throw new IntradayGrpcClientUnavailableError(err);
    }
  }
}
