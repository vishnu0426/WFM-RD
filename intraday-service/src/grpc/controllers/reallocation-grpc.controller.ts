import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { ReallocationQueryService } from '../../reallocation/reallocation-query.service';

interface GetReallocationForExplanationRequest {
  tenantId: string;
  reallocationActionId: string;
}

interface GetReallocationForExplanationResponse {
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

const NOT_FOUND: GetReallocationForExplanationResponse = {
  found: false,
  tenantId: '',
  triggeredBy: '',
  fromQueueId: '',
  toQueueId: '',
  affectedEmployeeIds: [],
  reason: '',
  status: '',
  aiRationaleJson: '',
  createdAt: '',
  executedAt: '',
};

interface ListReallocationsForPeriodRequest {
  tenantId: string;
  periodStart: string;
  periodEnd: string;
}

interface ReallocationSummary {
  id: string;
  fromQueueId: string;
  toQueueId: string;
  status: string;
  reason: string;
  createdAt: string;
}

interface ListReallocationsForPeriodResponse {
  reallocations: ReallocationSummary[];
  totalMatchedBeforeCap: number;
}

/**
 * docs/adr/0120: `ReallocationService` - this service's first gRPC server
 * (every prior cross-module call involving Module 05 has gone the other
 * way, this module calling out via gRPC clients). Tenant context has no
 * HTTP middleware to bind it here (same ADR-0021 posture every other
 * internal gRPC controller in this platform follows) - bound explicitly
 * from the request message's own `tenant_id`.
 */
@Controller()
export class ReallocationGrpcController {
  constructor(private readonly reallocationQueryService: ReallocationQueryService) {}

  @GrpcMethod('ReallocationService', 'GetReallocationForExplanation')
  async getReallocationForExplanation(
    request: GetReallocationForExplanationRequest,
  ): Promise<GetReallocationForExplanationResponse> {
    if (!request.tenantId || !request.reallocationActionId) {
      return NOT_FOUND;
    }
    const action = await this.reallocationQueryService.getById(request.tenantId, request.reallocationActionId);
    if (!action) {
      return NOT_FOUND;
    }
    return {
      found: true,
      tenantId: action.tenantId,
      triggeredBy: action.triggeredBy,
      fromQueueId: action.fromQueueId,
      toQueueId: action.toQueueId,
      affectedEmployeeIds: action.affectedEmployeeIds,
      reason: action.reason,
      status: action.status,
      aiRationaleJson: action.aiRationale ? JSON.stringify(action.aiRationale) : '',
      createdAt: action.createdAt.toISOString(),
      executedAt: action.executedAt ? action.executedAt.toISOString() : '',
    };
  }

  @GrpcMethod('ReallocationService', 'ListReallocationsForPeriod')
  async listReallocationsForPeriod(
    request: ListReallocationsForPeriodRequest,
  ): Promise<ListReallocationsForPeriodResponse> {
    if (!request.tenantId || !request.periodStart || !request.periodEnd) {
      return { reallocations: [], totalMatchedBeforeCap: 0 };
    }
    const { rows, totalMatchedBeforeCap } = await this.reallocationQueryService.listForPeriod(
      request.tenantId,
      new Date(request.periodStart),
      new Date(request.periodEnd),
    );
    return {
      reallocations: rows.map((action) => ({
        id: action.id,
        fromQueueId: action.fromQueueId,
        toQueueId: action.toQueueId,
        status: action.status,
        reason: action.reason,
        createdAt: action.createdAt.toISOString(),
      })),
      totalMatchedBeforeCap,
    };
  }
}
