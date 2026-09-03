import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { withTenantConnection } from '../database/with-tenant-connection';
import { AdherenceScore } from './entities/adherence-score.entity';
import { EmployeeGrpcClientService } from '../grpc/employee-grpc-client.service';

export interface OrgUnitAdherenceSummary {
  /** Echoed from the scored rows themselves, not merely the request's own field - see AdherenceRollupGrpcController's own doc comment. */
  tenantId: string;
  employeeCount: number;
  scoredEmployeeCount: number;
  periodCount: number;
  averageAdherencePct: string;
  totalMajorDeviationCount: number;
  minAdherencePct: string;
  maxAdherencePct: string;
}

/**
 * Module 10 Phase 4 (docs/adr/0121): root-cause-analysis's adherence data
 * source. Same roster-then-`AdherenceScore` join
 * `ComplianceReportService.buildAdherenceSummary` already uses for the
 * `adherence_summary` CSV report - this is that same real, already-computed
 * data, aggregated into a summary instead of dumped as one row per
 * employee/period, since a root-cause narrative needs "how bad, and how
 * consistently," not a full per-employee ledger.
 */
@Injectable()
export class AdherenceRollupService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly employeeGrpcClient: EmployeeGrpcClientService,
  ) {}

  async getOrgUnitAdherenceSummary(
    tenantId: string,
    orgUnitId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<OrgUnitAdherenceSummary | null> {
    const roster = await this.employeeGrpcClient.getSchedulableRoster(tenantId, orgUnitId);
    const employeeIds = roster.map((e) => e.employeeId);
    if (employeeIds.length === 0) {
      return null;
    }

    const scores = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager
        .getRepository(AdherenceScore)
        .createQueryBuilder('score')
        .where('score.employee_id = ANY(:employeeIds)', { employeeIds })
        .andWhere('score.period_start >= :periodStart', { periodStart })
        .andWhere('score.period_start < :periodEnd', { periodEnd })
        .getMany(),
    );

    if (scores.length === 0) {
      return null;
    }

    const pctValues = scores.map((s) => Number(s.adherencePct));
    const scoredEmployeeIds = new Set(scores.map((s) => s.employeeId));
    const totalMajorDeviationCount = scores.reduce((sum, s) => sum + s.majorDeviationCount, 0);
    const average = pctValues.reduce((sum, v) => sum + v, 0) / pctValues.length;

    return {
      // Echoed from a scored row (RLS already guarantees every row here
      // belongs to `tenantId`, but §5.1's defense-in-depth posture is to
      // never hand the caller back its own unverified input as if it were
      // an independent fact).
      tenantId: scores[0].tenantId,
      employeeCount: employeeIds.length,
      scoredEmployeeCount: scoredEmployeeIds.size,
      periodCount: scores.length,
      averageAdherencePct: average.toFixed(2),
      totalMajorDeviationCount,
      minAdherencePct: Math.min(...pctValues).toFixed(2),
      maxAdherencePct: Math.max(...pctValues).toFixed(2),
    };
  }
}
