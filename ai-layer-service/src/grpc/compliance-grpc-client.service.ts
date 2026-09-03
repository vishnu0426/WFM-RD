import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, Observable, timeout } from 'rxjs';
import { COMPLIANCE_GRPC_PACKAGE } from './compliance-grpc-client.constants';
import { DomainError } from '../common/errors/domain-error';

export interface GetOrgUnitAdherenceSummaryRequest {
  tenantId: string;
  orgUnitId: string;
  periodStart: string;
  periodEnd: string;
}

export interface OrgUnitAdherenceSummary {
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

interface AdherenceRollupServiceClient {
  getOrgUnitAdherenceSummary(request: GetOrgUnitAdherenceSummaryRequest): Observable<OrgUnitAdherenceSummary>;
}

/** Own copy of every other cross-service gRPC client's budget/rationale - no reason for this call to wait longer than any other. */
const CALL_TIMEOUT_MS = 3000;

export class ComplianceGrpcClientUnavailableError extends DomainError {
  constructor(cause: unknown) {
    super(
      'COMPLIANCE_SERVICE_UNAVAILABLE',
      `AdherenceRollupService.GetOrgUnitAdherenceSummary unavailable: ${(cause as Error).message}`,
    );
  }
}

/** Phase 4 (docs/adr/0121): thin wrapper over `AdherenceRollupService.GetOrgUnitAdherenceSummary`. */
@Injectable()
export class ComplianceGrpcClientService implements OnModuleInit {
  private client!: AdherenceRollupServiceClient;

  constructor(@Inject(COMPLIANCE_GRPC_PACKAGE) private readonly grpcClient: ClientGrpc) {}

  onModuleInit(): void {
    this.client = this.grpcClient.getService<AdherenceRollupServiceClient>('AdherenceRollupService');
  }

  async getOrgUnitAdherenceSummary(
    tenantId: string,
    orgUnitId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<OrgUnitAdherenceSummary> {
    try {
      return await firstValueFrom(
        this.client
          .getOrgUnitAdherenceSummary({ tenantId, orgUnitId, periodStart, periodEnd })
          .pipe(timeout(CALL_TIMEOUT_MS)),
      );
    } catch (err) {
      throw new ComplianceGrpcClientUnavailableError(err);
    }
  }
}
