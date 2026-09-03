import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, Observable, timeout } from 'rxjs';
import { SCHEDULING_GRPC_PACKAGE } from './scheduling-grpc-client.constants';
import { DomainError } from '../common/errors/domain-error';

export interface GetScheduleJobForExplanationRequest {
  tenantId: string;
  jobId: string;
}

export interface ScheduleJobForExplanation {
  found: boolean;
  tenantId: string;
  status: string;
  orgUnitId: string;
  dateRangeStart: string;
  dateRangeEnd: string;
  objectiveScore: string;
  constraintConfigJson: string;
  relaxationsAppliedJson: string;
  decompositionPlanJson: string;
  completedAt: string;
}

interface ScheduleExplanationDataServiceClient {
  getScheduleJobForExplanation(request: GetScheduleJobForExplanationRequest): Observable<ScheduleJobForExplanation>;
}

/** Own copy of every other cross-service gRPC client's budget/rationale - no reason for this call to wait longer than any other. */
const CALL_TIMEOUT_MS = 3000;

export class SchedulingGrpcClientUnavailableError extends DomainError {
  constructor(cause: unknown) {
    super(
      'SCHEDULING_SERVICE_UNAVAILABLE',
      `ScheduleExplanationDataService.GetScheduleJobForExplanation unavailable: ${(cause as Error).message}`,
    );
  }
}

/**
 * Phase 2 (docs/adr/0115): thin wrapper over
 * `ScheduleExplanationDataService.GetScheduleJobForExplanation` - the raw
 * structured data `ScheduleExplanationService` translates into an LLM
 * prompt, per non-negotiable #2 (never asked to derive an answer from
 * general knowledge). Unary, so this is a plain Promise wrapper, no
 * `toArray()` collection step the way `ScheduleQueryGrpcClientService`'s own
 * server-streaming copy needs.
 */
@Injectable()
export class SchedulingGrpcClientService implements OnModuleInit {
  private client!: ScheduleExplanationDataServiceClient;

  constructor(@Inject(SCHEDULING_GRPC_PACKAGE) private readonly grpcClient: ClientGrpc) {}

  onModuleInit(): void {
    this.client = this.grpcClient.getService<ScheduleExplanationDataServiceClient>('ScheduleExplanationDataService');
  }

  async getScheduleJobForExplanation(tenantId: string, jobId: string): Promise<ScheduleJobForExplanation> {
    try {
      return await firstValueFrom(
        this.client.getScheduleJobForExplanation({ tenantId, jobId }).pipe(timeout(CALL_TIMEOUT_MS)),
      );
    } catch (err) {
      throw new SchedulingGrpcClientUnavailableError(err);
    }
  }
}
