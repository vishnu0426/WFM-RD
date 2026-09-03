import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { AdherenceRollupService } from '../../adherence/adherence-rollup.service';

interface GetOrgUnitAdherenceSummaryRequest {
  tenantId: string;
  orgUnitId: string;
  periodStart: string;
  periodEnd: string;
}

interface GetOrgUnitAdherenceSummaryResponse {
  found: boolean;
  tenantId: string;
  employeeCount: number;
  scoredEmployeeCount: number;
  periodCount: number;
  averageAdherencePct: string;
  totalMajorDeviationCount: number;
  minAdherencePct: string;
  maxAdherencePct: string;
}

const NOT_FOUND: GetOrgUnitAdherenceSummaryResponse = {
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

/** docs/adr/0121: `AdherenceRollupService` - this service's second gRPC surface, same tenant-context-from-request-message posture as `ComplianceRuleGrpcController`. */
@Controller()
export class AdherenceRollupGrpcController {
  constructor(private readonly adherenceRollupService: AdherenceRollupService) {}

  @GrpcMethod('AdherenceRollupService', 'GetOrgUnitAdherenceSummary')
  async getOrgUnitAdherenceSummary(
    request: GetOrgUnitAdherenceSummaryRequest,
  ): Promise<GetOrgUnitAdherenceSummaryResponse> {
    if (!request.tenantId || !request.orgUnitId || !request.periodStart || !request.periodEnd) {
      return NOT_FOUND;
    }
    const summary = await this.adherenceRollupService.getOrgUnitAdherenceSummary(
      request.tenantId,
      request.orgUnitId,
      new Date(request.periodStart),
      new Date(request.periodEnd),
    );
    if (!summary) {
      return NOT_FOUND;
    }
    return {
      found: true,
      tenantId: summary.tenantId,
      employeeCount: summary.employeeCount,
      scoredEmployeeCount: summary.scoredEmployeeCount,
      periodCount: summary.periodCount,
      averageAdherencePct: summary.averageAdherencePct,
      totalMajorDeviationCount: summary.totalMajorDeviationCount,
      minAdherencePct: summary.minAdherencePct,
      maxAdherencePct: summary.maxAdherencePct,
    };
  }
}
