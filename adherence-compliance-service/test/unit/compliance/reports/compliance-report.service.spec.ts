import { ComplianceReportService } from '../../../../src/compliance/reports/compliance-report.service';
import {
  ComplianceReport,
  ComplianceReportStatus,
  ComplianceReportType,
} from '../../../../src/compliance/entities/compliance-report.entity';
import { ComplianceRuleType } from '../../../../src/compliance/entities/compliance-rule.entity';
import { ComplianceReportNotFoundError } from '../../../../src/compliance/reports/errors/compliance-report-not-found.error';
import { OrgUnitScopeRequiredError } from '../../../../src/compliance/reports/errors/org-unit-scope-required.error';

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('ComplianceReportService', () => {
  let manager: {
    query: jest.Mock;
    insert: jest.Mock;
    findOne: jest.Mock;
    findOneByOrFail: jest.Mock;
    find: jest.Mock;
    update: jest.Mock;
    getRepository: jest.Mock;
  };
  let queryBuilder: {
    where: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    addOrderBy: jest.Mock;
    getMany: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };
  let metrics: { recordComplianceReportGeneration: jest.Mock; recordComplianceRuleUnresolvedForReport: jest.Mock };
  let employeeGrpcClient: { getSchedulableRoster: jest.Mock };
  let calendarGrpcClient: { getWorkingTimeRules: jest.Mock };
  let scheduleQueryGrpcClient: { listPublishedShiftAssignments: jest.Mock };
  let complianceRuleService: { getActiveRule: jest.Mock; findEffectiveRules: jest.Mock; listRules: jest.Mock };
  let s3Storage: { upload: jest.Mock; getPresignedDownloadUrl: jest.Mock };
  let service: ComplianceReportService;

  beforeEach(() => {
    queryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    manager = {
      query: jest.fn(),
      insert: jest.fn(),
      findOne: jest.fn(),
      findOneByOrFail: jest.fn(),
      find: jest.fn(),
      update: jest.fn(),
      getRepository: jest.fn().mockReturnValue({ createQueryBuilder: jest.fn().mockReturnValue(queryBuilder) }),
    };
    dataSource = { transaction: jest.fn(async (work: (m: unknown) => unknown) => work(manager)) };
    metrics = {
      recordComplianceReportGeneration: jest.fn(),
      recordComplianceRuleUnresolvedForReport: jest.fn(),
    };
    employeeGrpcClient = { getSchedulableRoster: jest.fn().mockResolvedValue([]) };
    calendarGrpcClient = { getWorkingTimeRules: jest.fn().mockResolvedValue({ countryCode: 'US' }) };
    scheduleQueryGrpcClient = { listPublishedShiftAssignments: jest.fn().mockResolvedValue([]) };
    complianceRuleService = {
      getActiveRule: jest.fn().mockResolvedValue(null),
      findEffectiveRules: jest.fn().mockResolvedValue([]),
      // GAP-03 fix: `auditAgainstRule` now checks rule *history* (any
      // status) when `getActiveRule` resolves null, to distinguish "never
      // configured" from "unresolvable for this asOf." Empty by default so
      // every pre-existing test keeps its original "no rule configured,
      // header-only table, no warning" behavior.
      listRules: jest.fn().mockResolvedValue([]),
    };
    s3Storage = {
      upload: jest.fn().mockResolvedValue({ uri: 's3://bucket/key.csv' }),
      getPresignedDownloadUrl: jest.fn(),
    };

    service = new ComplianceReportService(
      dataSource as never,
      metrics as never,
      employeeGrpcClient as never,
      calendarGrpcClient as never,
      scheduleQueryGrpcClient as never,
      complianceRuleService as never,
      s3Storage as never,
    );
  });

  describe('requestReport', () => {
    const baseInput = {
      reportType: ComplianceReportType.ADHERENCE_SUMMARY,
      dateRangeStart: '2026-06-01',
      dateRangeEnd: '2026-06-30',
      generatedBy: 'admin-1',
    };

    it('throws OrgUnitScopeRequiredError for overtime_audit with no orgUnitScope, before ever touching the database', async () => {
      await expect(
        service.requestReport('tenant-1', { ...baseInput, reportType: ComplianceReportType.OVERTIME_AUDIT }),
      ).rejects.toBeInstanceOf(OrgUnitScopeRequiredError);
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it('inserts a pending row with a computed retentionExpiresAt and returns it', async () => {
      manager.findOneByOrFail.mockResolvedValue({ id: 'report-1', status: ComplianceReportStatus.PENDING });

      const report = await service.requestReport('tenant-1', baseInput);

      expect(manager.insert).toHaveBeenCalledWith(
        ComplianceReport,
        expect.objectContaining({
          tenantId: 'tenant-1',
          reportType: ComplianceReportType.ADHERENCE_SUMMARY,
          status: ComplianceReportStatus.PENDING,
          fileUri: null,
          legalHold: false,
          generatedBy: 'admin-1',
        }),
      );
      expect(report).toEqual({ id: 'report-1', status: ComplianceReportStatus.PENDING });
    });

    it('defaults retentionExpiresAt to 7 years out when no orgUnitScope is given (no jurisdiction to look up a policy for)', async () => {
      manager.findOneByOrFail.mockResolvedValue({ id: 'report-1' });

      await service.requestReport('tenant-1', baseInput);

      const insertedRow = manager.insert.mock.calls[0][1];
      const expectedYear = insertedRow.generatedAt.getUTCFullYear() + 7;
      expect(insertedRow.retentionExpiresAt.getUTCFullYear()).toBe(expectedYear);
      expect(calendarGrpcClient.getWorkingTimeRules).not.toHaveBeenCalled();
    });
  });

  describe('getReport', () => {
    it('throws ComplianceReportNotFoundError when the row does not exist', async () => {
      manager.findOne.mockResolvedValue(null);
      await expect(service.getReport('tenant-1', 'missing')).rejects.toBeInstanceOf(ComplianceReportNotFoundError);
    });

    it("throws ComplianceReportNotFoundError for another tenant's row", async () => {
      manager.findOne.mockResolvedValue({ id: 'report-1', tenantId: 'tenant-2' });
      await expect(service.getReport('tenant-1', 'report-1')).rejects.toBeInstanceOf(ComplianceReportNotFoundError);
    });

    it('returns null downloadUrl when the report has no fileUri yet (still pending)', async () => {
      manager.findOne.mockResolvedValue({ id: 'report-1', tenantId: 'tenant-1', fileUri: null });
      const result = await service.getReport('tenant-1', 'report-1');
      expect(result.downloadUrl).toBeNull();
      expect(s3Storage.getPresignedDownloadUrl).not.toHaveBeenCalled();
    });

    it('computes a presigned download URL once the report has a fileUri', async () => {
      manager.findOne.mockResolvedValue({ id: 'report-1', tenantId: 'tenant-1', fileUri: 's3://bucket/key.csv' });
      s3Storage.getPresignedDownloadUrl.mockResolvedValue('https://presigned.example.com/key.csv');
      const result = await service.getReport('tenant-1', 'report-1');
      expect(result.downloadUrl).toBe('https://presigned.example.com/key.csv');
    });
  });

  describe('setLegalHold', () => {
    it('throws ComplianceReportNotFoundError when the row does not exist', async () => {
      manager.findOne.mockResolvedValue(null);
      await expect(service.setLegalHold('tenant-1', 'missing', true)).rejects.toBeInstanceOf(
        ComplianceReportNotFoundError,
      );
      expect(manager.update).not.toHaveBeenCalled();
    });

    it("throws ComplianceReportNotFoundError for another tenant's row, never issuing the update", async () => {
      manager.findOne.mockResolvedValue({ id: 'report-1', tenantId: 'tenant-2' });
      await expect(service.setLegalHold('tenant-1', 'report-1', true)).rejects.toBeInstanceOf(
        ComplianceReportNotFoundError,
      );
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('updates legalHold and returns the updated row', async () => {
      manager.findOne.mockResolvedValue({ id: 'report-1', tenantId: 'tenant-1', legalHold: false });
      manager.findOneByOrFail.mockResolvedValue({ id: 'report-1', tenantId: 'tenant-1', legalHold: true });

      const report = await service.setLegalHold('tenant-1', 'report-1', true);

      expect(manager.update).toHaveBeenCalledWith(ComplianceReport, { id: 'report-1' }, { legalHold: true });
      expect(report.legalHold).toBe(true);
    });
  });

  describe('listReports', () => {
    it('returns every row for the tenant, newest first', async () => {
      const rows = [
        { id: 'report-2', tenantId: 'tenant-1', generatedAt: new Date('2026-02-01') },
        { id: 'report-1', tenantId: 'tenant-1', generatedAt: new Date('2026-01-01') },
      ];
      manager.find.mockResolvedValue(rows);

      const result = await service.listReports('tenant-1');

      expect(manager.find).toHaveBeenCalledWith(ComplianceReport, { order: { generatedAt: 'DESC' } });
      expect(result).toEqual(rows);
    });
  });

  describe('generate (via requestReport, awaited through microtask flush)', () => {
    /** `requestReport` generates a real `randomUUID()` id internally - echo back whatever was actually inserted, rather than a hardcoded fake id, so `generate`'s own lookup (and this test's assertions) see the real one. */
    function echoInsertedRow(): void {
      manager.insert.mockImplementation((_entity: unknown, row: ComplianceReport) => {
        manager.findOneByOrFail.mockResolvedValue(row);
        return Promise.resolve();
      });
    }

    it('uploads the built CSV and marks the report completed', async () => {
      echoInsertedRow();

      const report = await service.requestReport('tenant-1', {
        reportType: ComplianceReportType.ADHERENCE_SUMMARY,
        dateRangeStart: '2026-06-01',
        dateRangeEnd: '2026-06-30',
        generatedBy: 'admin-1',
      });
      await flushMicrotasks();

      expect(s3Storage.upload).toHaveBeenCalledWith(
        `reports/tenant-1/${report.id}.csv`,
        expect.any(String),
        'text/csv',
      );
      expect(manager.update).toHaveBeenCalledWith(
        ComplianceReport,
        { id: report.id },
        { status: ComplianceReportStatus.COMPLETED, fileUri: 's3://bucket/key.csv' },
      );
      expect(metrics.recordComplianceReportGeneration).toHaveBeenCalledWith(
        ComplianceReportType.ADHERENCE_SUMMARY,
        'completed',
      );
    });

    it('marks the report failed, records the metric, and never throws out of the fire-and-forget path when upload fails', async () => {
      echoInsertedRow();
      s3Storage.upload.mockRejectedValue(new Error('S3 unreachable'));

      const report = await service.requestReport('tenant-1', {
        reportType: ComplianceReportType.ADHERENCE_SUMMARY,
        dateRangeStart: '2026-06-01',
        dateRangeEnd: '2026-06-30',
        generatedBy: 'admin-1',
      });
      await flushMicrotasks();

      expect(manager.update).toHaveBeenCalledWith(
        ComplianceReport,
        { id: report.id },
        { status: ComplianceReportStatus.FAILED },
      );
      expect(metrics.recordComplianceReportGeneration).toHaveBeenCalledWith(
        ComplianceReportType.ADHERENCE_SUMMARY,
        'failed',
      );
    });

    it('resolves jurisdiction via CalendarService and audits against the active rule for overtime_audit', async () => {
      const pendingRow = {
        id: 'report-2',
        tenantId: 'tenant-1',
        reportType: ComplianceReportType.OVERTIME_AUDIT,
        dateRangeStart: '2026-06-01',
        dateRangeEnd: '2026-06-30',
        orgUnitScope: 'org-1',
      };
      manager.findOneByOrFail.mockResolvedValue(pendingRow);
      employeeGrpcClient.getSchedulableRoster.mockResolvedValue([{ employeeId: 'emp-1', orgUnitId: 'org-1' }]);
      scheduleQueryGrpcClient.listPublishedShiftAssignments.mockResolvedValue([
        {
          employeeId: 'emp-1',
          scheduleId: 'sched-1',
          shiftStart: '2026-06-01T09:00:00Z',
          shiftEnd: '2026-06-01T20:00:00Z',
          isOvertime: false,
        },
      ]);
      complianceRuleService.getActiveRule.mockResolvedValue({
        ruleType: ComplianceRuleType.OVERTIME_THRESHOLD,
        citation: 'Overtime citation',
        definition: { dailyThresholdHours: 8 },
      });

      await service.requestReport('tenant-1', {
        reportType: ComplianceReportType.OVERTIME_AUDIT,
        dateRangeStart: '2026-06-01',
        dateRangeEnd: '2026-06-30',
        orgUnitScope: 'org-1',
        generatedBy: 'admin-1',
      });
      await flushMicrotasks();

      expect(calendarGrpcClient.getWorkingTimeRules).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-1', orgUnitId: 'org-1' }),
      );
      expect(complianceRuleService.getActiveRule).toHaveBeenCalledWith(
        'tenant-1',
        'US',
        ComplianceRuleType.OVERTIME_THRESHOLD,
        expect.any(Date),
      );
      const uploadedCsv = s3Storage.upload.mock.calls[0][1];
      expect(uploadedCsv).toContain('worked 11.00h on 2026-06-01 (daily threshold 8h)');
      expect(metrics.recordComplianceReportGeneration).toHaveBeenCalledWith(
        ComplianceReportType.OVERTIME_AUDIT,
        'completed',
      );
    });

    it('GAP-03 fix: warns and increments a metric when rule history exists for this ruleType but none resolves for the requested asOf - distinct from "never configured"', async () => {
      const pendingRow = {
        id: 'report-3',
        tenantId: 'tenant-1',
        reportType: ComplianceReportType.OVERTIME_AUDIT,
        dateRangeStart: '2026-06-01',
        dateRangeEnd: '2026-06-30',
        orgUnitScope: 'org-1',
      };
      manager.findOneByOrFail.mockResolvedValue(pendingRow);
      employeeGrpcClient.getSchedulableRoster.mockResolvedValue([]);
      complianceRuleService.getActiveRule.mockResolvedValue(null);
      complianceRuleService.listRules.mockResolvedValue([
        { ruleType: ComplianceRuleType.OVERTIME_THRESHOLD, id: 'some-superseded-or-future-row' },
      ]);

      await service.requestReport('tenant-1', {
        reportType: ComplianceReportType.OVERTIME_AUDIT,
        dateRangeStart: '2026-06-01',
        dateRangeEnd: '2026-06-30',
        orgUnitScope: 'org-1',
        generatedBy: 'admin-1',
      });
      await flushMicrotasks();

      expect(metrics.recordComplianceRuleUnresolvedForReport).toHaveBeenCalledWith(
        ComplianceRuleType.OVERTIME_THRESHOLD,
      );
    });

    it('GAP-03 fix: does not warn when no rule of this type was ever configured for the jurisdiction - a legitimate empty report', async () => {
      const pendingRow = {
        id: 'report-4',
        tenantId: 'tenant-1',
        reportType: ComplianceReportType.OVERTIME_AUDIT,
        dateRangeStart: '2026-06-01',
        dateRangeEnd: '2026-06-30',
        orgUnitScope: 'org-1',
      };
      manager.findOneByOrFail.mockResolvedValue(pendingRow);
      employeeGrpcClient.getSchedulableRoster.mockResolvedValue([]);
      complianceRuleService.getActiveRule.mockResolvedValue(null);
      complianceRuleService.listRules.mockResolvedValue([]);

      await service.requestReport('tenant-1', {
        reportType: ComplianceReportType.OVERTIME_AUDIT,
        dateRangeStart: '2026-06-01',
        dateRangeEnd: '2026-06-30',
        orgUnitScope: 'org-1',
        generatedBy: 'admin-1',
      });
      await flushMicrotasks();

      expect(metrics.recordComplianceRuleUnresolvedForReport).not.toHaveBeenCalled();
    });
  });
});
