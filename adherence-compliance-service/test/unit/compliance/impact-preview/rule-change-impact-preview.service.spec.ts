import { RuleChangeImpactPreviewService } from '../../../../src/compliance/impact-preview/rule-change-impact-preview.service';
import { ComplianceRuleType } from '../../../../src/compliance/entities/compliance-rule.entity';
import { ComplianceRuleNotOwnedError } from '../../../../src/compliance/errors/compliance-rule-not-owned.error';

describe('RuleChangeImpactPreviewService', () => {
  let manager: { query: jest.Mock; insert: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let complianceRuleService: { getOwnedRule: jest.Mock; getActiveRule: jest.Mock };
  let employeeGrpcClient: { getSchedulableRoster: jest.Mock };
  let scheduleQueryGrpcClient: { listPublishedShiftAssignments: jest.Mock };
  let service: RuleChangeImpactPreviewService;

  const rule = {
    id: 'rule-1',
    tenantId: 'tenant-1',
    jurisdiction: 'US-CA',
    ruleType: ComplianceRuleType.REST_PERIOD_MINIMUM,
    definition: { minRestHoursBetweenShifts: 10 },
  };

  beforeEach(() => {
    manager = { query: jest.fn(), insert: jest.fn() };
    dataSource = { transaction: jest.fn(async (work: (m: unknown) => unknown) => work(manager)) };
    complianceRuleService = {
      getOwnedRule: jest.fn().mockResolvedValue(rule),
      getActiveRule: jest.fn().mockResolvedValue(null),
    };
    employeeGrpcClient = { getSchedulableRoster: jest.fn().mockResolvedValue([]) };
    scheduleQueryGrpcClient = { listPublishedShiftAssignments: jest.fn().mockResolvedValue([]) };

    service = new RuleChangeImpactPreviewService(
      dataSource as never,
      complianceRuleService as never,
      employeeGrpcClient as never,
      scheduleQueryGrpcClient as never,
    );
  });

  it('propagates ComplianceRuleNotOwnedError from getOwnedRule without calling any gRPC client', async () => {
    complianceRuleService.getOwnedRule.mockRejectedValue(new ComplianceRuleNotOwnedError('rule-1'));
    await expect(service.generatePreview('tenant-1', 'rule-1', ['org-1'])).rejects.toBeInstanceOf(
      ComplianceRuleNotOwnedError,
    );
    expect(employeeGrpcClient.getSchedulableRoster).not.toHaveBeenCalled();
  });

  it('produces a zero-count preview when the roster is empty, still inserting a row', async () => {
    const preview = await service.generatePreview('tenant-1', 'rule-1', ['org-1']);

    expect(preview.wouldBecomeNoncompliantCount).toBe(0);
    expect(preview.affectedEmployeeIds).toEqual([]);
    expect(preview.tenantId).toBe('tenant-1');
    expect(preview.complianceRuleId).toBe('rule-1');
    expect(manager.insert).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tenantId: 'tenant-1' }));
  });

  it('counts an employee as newly affected only when compliant under the baseline but not under the candidate rule', async () => {
    employeeGrpcClient.getSchedulableRoster.mockResolvedValue([
      { employeeId: 'emp-1', orgUnitId: 'org-1' },
      { employeeId: 'emp-2', orgUnitId: 'org-1' },
    ]);
    // emp-1: an 8h gap between shifts - compliant under an 8h baseline, non-compliant under this rule's 10h floor.
    // emp-2: a 12h gap - compliant under both.
    scheduleQueryGrpcClient.listPublishedShiftAssignments.mockResolvedValue([
      {
        employeeId: 'emp-1',
        scheduleId: 'sched-1',
        shiftStart: '2026-06-01T09:00:00Z',
        shiftEnd: '2026-06-01T17:00:00Z',
        isOvertime: false,
      },
      {
        employeeId: 'emp-1',
        scheduleId: 'sched-1',
        shiftStart: '2026-06-02T01:00:00Z',
        shiftEnd: '2026-06-02T09:00:00Z',
        isOvertime: false,
      },
      {
        employeeId: 'emp-2',
        scheduleId: 'sched-2',
        shiftStart: '2026-06-01T09:00:00Z',
        shiftEnd: '2026-06-01T17:00:00Z',
        isOvertime: false,
      },
      {
        employeeId: 'emp-2',
        scheduleId: 'sched-2',
        shiftStart: '2026-06-02T05:00:00Z',
        shiftEnd: '2026-06-02T13:00:00Z',
        isOvertime: false,
      },
    ]);
    complianceRuleService.getActiveRule.mockResolvedValue({
      ...rule,
      id: 'baseline-rule',
      definition: { minRestHoursBetweenShifts: 8 },
    });

    const preview = await service.generatePreview('tenant-1', 'rule-1', ['org-1']);

    expect(preview.wouldBecomeNoncompliantCount).toBe(1);
    expect(preview.affectedEmployeeIds).toEqual(['emp-1']);
    expect(preview.affectedOrgUnitIds).toEqual(['org-1']);
    expect(preview.simulatedAgainstScheduleIds.sort()).toEqual(['sched-1', 'sched-2']);
  });

  it('treats no active baseline rule as "everyone starts compliant" - a bare non-compliance under the candidate still counts', async () => {
    employeeGrpcClient.getSchedulableRoster.mockResolvedValue([{ employeeId: 'emp-1', orgUnitId: 'org-1' }]);
    scheduleQueryGrpcClient.listPublishedShiftAssignments.mockResolvedValue([
      {
        employeeId: 'emp-1',
        scheduleId: 'sched-1',
        shiftStart: '2026-06-01T09:00:00Z',
        shiftEnd: '2026-06-01T17:00:00Z',
        isOvertime: false,
      },
      {
        employeeId: 'emp-1',
        scheduleId: 'sched-1',
        shiftStart: '2026-06-02T01:00:00Z',
        shiftEnd: '2026-06-02T09:00:00Z',
        isOvertime: false,
      },
    ]);
    // getActiveRule resolves null (default from beforeEach) - no floor currently in force for this jurisdiction/ruleType.

    const preview = await service.generatePreview('tenant-1', 'rule-1', ['org-1']);

    expect(preview.wouldBecomeNoncompliantCount).toBe(1);
    expect(preview.affectedEmployeeIds).toEqual(['emp-1']);
  });

  it('dedupes employees appearing on multiple org unit rosters before querying schedules', async () => {
    employeeGrpcClient.getSchedulableRoster.mockImplementation(async (_tenantId: string, orgUnitId: string) => [
      { employeeId: 'emp-1', orgUnitId },
    ]);

    await service.generatePreview('tenant-1', 'rule-1', ['org-1', 'org-2']);

    expect(scheduleQueryGrpcClient.listPublishedShiftAssignments).toHaveBeenCalledWith(
      'tenant-1',
      ['emp-1'],
      expect.any(Date),
      expect.any(Date),
    );
  });
});
