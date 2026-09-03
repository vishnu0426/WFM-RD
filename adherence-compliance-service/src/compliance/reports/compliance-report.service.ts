import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';
import { withTenantConnection } from '../../database/with-tenant-connection';
import { MetricsService } from '../../common/metrics/metrics.service';
import { CalendarGrpcClientService } from '../../grpc/calendar-grpc-client.service';
import { EmployeeGrpcClientService } from '../../grpc/employee-grpc-client.service';
import { ScheduleQueryGrpcClientService } from '../../grpc/schedule-query-grpc-client.service';
import { ComplianceRuleService } from '../compliance-rule.service';
import { ComplianceRuleType } from '../entities/compliance-rule.entity';
import { AdherenceScore } from '../../adherence/entities/adherence-score.entity';
import { ComplianceReport, ComplianceReportStatus, ComplianceReportType } from '../entities/compliance-report.entity';
import { RetentionPolicy } from '../entities/retention-policy.entity';
import { CreateComplianceReportDto } from './dto/create-compliance-report.dto';
import { ComplianceReportNotFoundError } from './errors/compliance-report-not-found.error';
import { OrgUnitScopeRequiredError } from './errors/org-unit-scope-required.error';
import { toCsv } from './csv';
import {
  buildAdherenceSummaryReport,
  buildRegulatorExportReport,
  buildViolationAuditReport,
  CsvTable,
  EmployeeShifts,
} from './report-builders';
import { SimulatedShift } from '../impact-preview/evaluate-schedule-compliance';
import { S3ReportStorageService } from './s3-report-storage.service';

/** docs/adr/0105: no `RetentionPolicy` row is seeded by anything yet (Phase 7's own scope) - a real, disclosed placeholder default, not a silent assumption, until Phase 7's seeding/lifecycle job exists. */
const DEFAULT_RETENTION_YEARS = 7;

const ORG_UNIT_SCOPE_REQUIRED_TYPES = new Set([
  ComplianceReportType.OVERTIME_AUDIT,
  ComplianceReportType.REST_PERIOD_AUDIT,
  ComplianceReportType.REGULATOR_EXPORT,
]);

export interface ReportWithDownloadUrl {
  report: ComplianceReport;
  downloadUrl: string | null;
}

/**
 * §3.2/§5b/docs/adr/0105: `generateComplianceReport` - async, but
 * in-process (no separate worker), fire-and-forget from
 * `requestReport`'s own perspective. See the ADR for why this differs
 * from scheduling-service's `ScheduleJob` worker-pool shape.
 */
@Injectable()
export class ComplianceReportService {
  private readonly logger = new Logger(ComplianceReportService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly metrics: MetricsService,
    private readonly employeeGrpcClient: EmployeeGrpcClientService,
    private readonly calendarGrpcClient: CalendarGrpcClientService,
    private readonly scheduleQueryGrpcClient: ScheduleQueryGrpcClientService,
    private readonly complianceRuleService: ComplianceRuleService,
    private readonly s3Storage: S3ReportStorageService,
  ) {}

  async requestReport(tenantId: string, input: CreateComplianceReportDto): Promise<ComplianceReport> {
    if (ORG_UNIT_SCOPE_REQUIRED_TYPES.has(input.reportType) && !input.orgUnitScope) {
      throw new OrgUnitScopeRequiredError(input.reportType);
    }

    const id = randomUUID();
    const generatedAt = new Date();
    const retentionExpiresAt = await this.resolveRetentionExpiry(tenantId, input.orgUnitScope, generatedAt);

    const report = await withTenantConnection(this.dataSource, tenantId, async (manager) => {
      await manager.insert(ComplianceReport, {
        id,
        tenantId,
        reportType: input.reportType,
        dateRangeStart: input.dateRangeStart,
        dateRangeEnd: input.dateRangeEnd,
        orgUnitScope: input.orgUnitScope ?? null,
        status: ComplianceReportStatus.PENDING,
        generatedAt,
        generatedBy: input.generatedBy,
        fileUri: null,
        retentionExpiresAt,
        legalHold: false,
      });
      return manager.findOneByOrFail(ComplianceReport, { id });
    });

    // Fire-and-forget: the HTTP response is the "accepted, pending" state
    // itself (docs/adr/0105) - a failure here is caught and recorded on the
    // row (`markFailed`), never thrown into an unhandled rejection.
    void this.generate(tenantId, id).catch((err: Error) => {
      this.logger.error(`Unhandled error generating compliance report ${id}: ${err.message}`, err.stack);
    });

    return report;
  }

  async getReport(tenantId: string, id: string): Promise<ReportWithDownloadUrl> {
    const report = await this.getOwnedReport(tenantId, id);
    const downloadUrl = report.fileUri ? await this.s3Storage.getPresignedDownloadUrl(report.fileUri) : null;
    return { report, downloadUrl };
  }

  /**
   * §4's report history list - had no backend surface at all before this
   * (only single-report-by-id existed, `GET /v1/compliance/reports/{id}`,
   * §3.2's own literal spec). Newest-first, unbounded (this table has no
   * pagination anywhere yet, same v1 scoping call `useAbsencePatterns`
   * documents for its own unbounded list) - a compliance officer's report
   * history is not yet expected to grow into the thousands within one
   * tenant.
   */
  async listReports(tenantId: string): Promise<ComplianceReport[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.find(ComplianceReport, { order: { generatedAt: 'DESC' } }),
    );
  }

  /**
   * docs/adr/0106: the retention lifecycle job's own write path -
   * `legal_hold` had no way to ever become `true` before this phase,
   * making the job's `WHERE ... AND NOT legal_hold` guard untestable and
   * the column dead weight from the API's perspective. No new
   * authorization model - matches this module's own §8 non-goal (no RBAC
   * anywhere in Module 08), the same posture every other write path in
   * this service already accepted.
   */
  async setLegalHold(tenantId: string, id: string, legalHold: boolean): Promise<ComplianceReport> {
    await this.getOwnedReport(tenantId, id);
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      await manager.update(ComplianceReport, { id }, { legalHold });
      return manager.findOneByOrFail(ComplianceReport, { id });
    });
  }

  private async getOwnedReport(tenantId: string, id: string): Promise<ComplianceReport> {
    const report = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.findOne(ComplianceReport, { where: { id } }),
    );
    if (!report || report.tenantId !== tenantId) {
      throw new ComplianceReportNotFoundError(id);
    }
    return report;
  }

  private async generate(tenantId: string, reportId: string): Promise<void> {
    const report = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.findOneByOrFail(ComplianceReport, { id: reportId }),
    );
    try {
      const table = await this.buildTable(tenantId, report);
      const csv = toCsv(table.headers, table.rows);
      const key = `reports/${tenantId}/${reportId}.csv`;
      const uploaded = await this.s3Storage.upload(key, csv, 'text/csv');

      await withTenantConnection(this.dataSource, tenantId, (manager) =>
        manager.update(
          ComplianceReport,
          { id: reportId },
          { status: ComplianceReportStatus.COMPLETED, fileUri: uploaded.uri },
        ),
      );
      this.metrics.recordComplianceReportGeneration(report.reportType, 'completed');
    } catch (err) {
      this.logger.error(
        `Failed to generate compliance report ${reportId}: ${(err as Error).message}`,
        (err as Error).stack,
      );
      await withTenantConnection(this.dataSource, tenantId, (manager) =>
        manager.update(ComplianceReport, { id: reportId }, { status: ComplianceReportStatus.FAILED }),
      );
      this.metrics.recordComplianceReportGeneration(report.reportType, 'failed');
    }
  }

  private async buildTable(tenantId: string, report: ComplianceReport): Promise<CsvTable> {
    switch (report.reportType) {
      case ComplianceReportType.ADHERENCE_SUMMARY:
        return this.buildAdherenceSummary(tenantId, report);
      case ComplianceReportType.OVERTIME_AUDIT:
        return this.buildAudit(tenantId, report, ComplianceRuleType.OVERTIME_THRESHOLD);
      case ComplianceReportType.REST_PERIOD_AUDIT:
        return this.buildAudit(tenantId, report, ComplianceRuleType.REST_PERIOD_MINIMUM);
      case ComplianceReportType.REGULATOR_EXPORT:
        return this.buildRegulatorExport(tenantId, report);
    }
  }

  private async buildAdherenceSummary(tenantId: string, report: ComplianceReport): Promise<CsvTable> {
    let employeeIds: string[] | null = null;
    if (report.orgUnitScope) {
      const roster = await this.employeeGrpcClient.getSchedulableRoster(tenantId, report.orgUnitScope);
      employeeIds = roster.map((e) => e.employeeId);
    }
    const { windowStart, windowEnd } = toWindow(report.dateRangeStart, report.dateRangeEnd);

    const scores = await withTenantConnection(this.dataSource, tenantId, (manager) => {
      const qb = manager
        .getRepository(AdherenceScore)
        .createQueryBuilder('score')
        .where('score.period_start >= :windowStart', { windowStart })
        .andWhere('score.period_start < :windowEnd', { windowEnd })
        .orderBy('score.employee_id', 'ASC')
        .addOrderBy('score.period_start', 'ASC');
      if (employeeIds !== null) {
        qb.andWhere('score.employee_id = ANY(:employeeIds)', { employeeIds });
      }
      return qb.getMany();
    });

    return buildAdherenceSummaryReport(scores);
  }

  private async buildAudit(
    tenantId: string,
    report: ComplianceReport,
    ruleType: ComplianceRuleType,
  ): Promise<CsvTable> {
    const orgUnitId = report.orgUnitScope as string;
    const jurisdiction = await this.resolveJurisdiction(tenantId, orgUnitId);
    const employeeShifts = await this.fetchEmployeeShifts(
      tenantId,
      orgUnitId,
      report.dateRangeStart,
      report.dateRangeEnd,
    );
    return this.auditAgainstRule(tenantId, jurisdiction, ruleType, report.dateRangeEnd, employeeShifts);
  }

  private async buildRegulatorExport(tenantId: string, report: ComplianceReport): Promise<CsvTable> {
    const orgUnitId = report.orgUnitScope as string;
    const jurisdiction = await this.resolveJurisdiction(tenantId, orgUnitId);
    const employeeShifts = await this.fetchEmployeeShifts(
      tenantId,
      orgUnitId,
      report.dateRangeStart,
      report.dateRangeEnd,
    );
    const activeRules = await this.complianceRuleService.findEffectiveRules(tenantId, jurisdiction);
    const overtimeAudit = await this.auditAgainstRule(
      tenantId,
      jurisdiction,
      ComplianceRuleType.OVERTIME_THRESHOLD,
      report.dateRangeEnd,
      employeeShifts,
    );
    const restPeriodAudit = await this.auditAgainstRule(
      tenantId,
      jurisdiction,
      ComplianceRuleType.REST_PERIOD_MINIMUM,
      report.dateRangeEnd,
      employeeShifts,
    );
    return buildRegulatorExportReport(activeRules, overtimeAudit, restPeriodAudit);
  }

  private async auditAgainstRule(
    tenantId: string,
    jurisdiction: string,
    ruleType: ComplianceRuleType,
    asOfDate: string,
    employeeShifts: EmployeeShifts[],
  ): Promise<CsvTable> {
    const rule = await this.complianceRuleService.getActiveRule(tenantId, jurisdiction, ruleType, new Date(asOfDate));
    if (!rule) {
      // GAP-03 fix: `resolveEffectiveRules` now considers `superseded` rows
      // too (see its own doc comment), so `rule === null` here should
      // almost always mean "this jurisdiction never had a ruleType rule at
      // all" - a legitimate, silent, header-only-table case, same as
      // before this fix. The one case worth distinguishing loudly: rule
      // *history* exists for this (jurisdiction, ruleType) but none of it
      // actually covers `asOfDate` - a real coverage gap, not a "nothing
      // to audit against" absence. `listRules` is a full-history read (any
      // status), so this check is independent of `resolveEffectiveRules`'s
      // own date/status filtering.
      const anyRuleEverExisted = (await this.complianceRuleService.listRules(tenantId, jurisdiction)).some(
        (r) => r.ruleType === ruleType,
      );
      if (anyRuleEverExisted) {
        this.metrics.recordComplianceRuleUnresolvedForReport(ruleType);
        this.logger.warn(
          `No ${ruleType} compliance rule resolves for tenant=${tenantId} jurisdiction=${jurisdiction} asOf=${asOfDate}, despite rule history existing for this (jurisdiction, ruleType) - report will show zero violations for this rule type; verify rule effective-date coverage.`,
        );
      }
    }
    return buildViolationAuditReport(
      ruleType,
      rule ? { citation: rule.citation, definition: rule.definition } : null,
      employeeShifts,
    );
  }

  private async resolveJurisdiction(tenantId: string, orgUnitId: string): Promise<string> {
    const rules = await this.calendarGrpcClient.getWorkingTimeRules({
      tenantId,
      orgUnitId,
      fromDate: new Date().toISOString().slice(0, 10),
      toDate: new Date().toISOString().slice(0, 10),
    });
    return rules.countryCode;
  }

  private async fetchEmployeeShifts(
    tenantId: string,
    orgUnitId: string,
    dateRangeStart: string,
    dateRangeEnd: string,
  ): Promise<EmployeeShifts[]> {
    const roster = await this.employeeGrpcClient.getSchedulableRoster(tenantId, orgUnitId);
    const employeeIds = roster.map((e) => e.employeeId);
    const { windowStart, windowEnd } = toWindow(dateRangeStart, dateRangeEnd);
    const records = await this.scheduleQueryGrpcClient.listPublishedShiftAssignments(
      tenantId,
      employeeIds,
      windowStart,
      windowEnd,
    );

    const shiftsByEmployeeId = new Map<string, SimulatedShift[]>();
    for (const record of records) {
      const shifts = shiftsByEmployeeId.get(record.employeeId) ?? [];
      shifts.push({
        employeeId: record.employeeId,
        start: new Date(record.shiftStart),
        end: new Date(record.shiftEnd),
      });
      shiftsByEmployeeId.set(record.employeeId, shifts);
    }
    return employeeIds.map((employeeId) => ({ employeeId, shifts: shiftsByEmployeeId.get(employeeId) ?? [] }));
  }

  /** docs/adr/0105: no `RetentionPolicy` row exists yet anywhere (nothing seeds one until Phase 7) - tenant-specific, then platform-default-by-jurisdiction, then a disclosed hardcoded fallback, in that order. `jurisdiction` is unknown at request time for `adherence_summary` with no `orgUnitScope` - falls straight to the hardcoded default in that case. */
  private async resolveRetentionExpiry(
    tenantId: string,
    orgUnitId: string | undefined,
    generatedAt: Date,
  ): Promise<Date> {
    let years = DEFAULT_RETENTION_YEARS;
    if (orgUnitId) {
      try {
        const jurisdiction = await this.resolveJurisdiction(tenantId, orgUnitId);
        const policy = await withTenantConnection(this.dataSource, tenantId, async (manager) => {
          const tenantPolicy = await manager.findOne(RetentionPolicy, { where: { tenantId, jurisdiction } });
          if (tenantPolicy) {
            return tenantPolicy;
          }
          return manager.findOne(RetentionPolicy, { where: { tenantId: IsNull(), jurisdiction } });
        });
        if (policy) {
          years = policy.retentionYears;
        }
      } catch (err) {
        this.logger.warn(
          `Could not resolve a RetentionPolicy for org unit ${orgUnitId} - using the default: ${(err as Error).message}`,
        );
      }
    }
    const expiry = new Date(generatedAt);
    expiry.setUTCFullYear(expiry.getUTCFullYear() + years);
    return expiry;
  }
}

function toWindow(dateRangeStart: string, dateRangeEnd: string): { windowStart: Date; windowEnd: Date } {
  const windowStart = new Date(`${dateRangeStart}T00:00:00.000Z`);
  const windowEnd = new Date(`${dateRangeEnd}T00:00:00.000Z`);
  windowEnd.setUTCDate(windowEnd.getUTCDate() + 1);
  return { windowStart, windowEnd };
}
