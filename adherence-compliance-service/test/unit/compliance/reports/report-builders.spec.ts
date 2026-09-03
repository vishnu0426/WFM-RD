import {
  buildAdherenceSummaryReport,
  buildRegulatorExportReport,
  buildViolationAuditReport,
} from '../../../../src/compliance/reports/report-builders';
import { ComplianceRuleType } from '../../../../src/compliance/entities/compliance-rule.entity';

describe('buildAdherenceSummaryReport', () => {
  it('produces one row per AdherenceScore, in the given order, with ISO timestamps', () => {
    const table = buildAdherenceSummaryReport([
      {
        employeeId: 'emp-1',
        periodType: 'day',
        periodStart: new Date('2026-06-01T00:00:00Z'),
        periodEnd: new Date('2026-06-02T00:00:00Z'),
        adherentSeconds: 3600,
        totalScheduledSeconds: 3800,
        adherencePct: '94.74',
        majorDeviationCount: 1,
      },
    ]);
    expect(table.headers).toEqual([
      'employeeId',
      'periodType',
      'periodStart',
      'periodEnd',
      'adherentSeconds',
      'totalScheduledSeconds',
      'adherencePct',
      'majorDeviationCount',
    ]);
    expect(table.rows).toEqual([
      ['emp-1', 'day', '2026-06-01T00:00:00.000Z', '2026-06-02T00:00:00.000Z', 3600, 3800, '94.74', 1],
    ]);
  });

  it('produces a header-only table for no scores', () => {
    expect(buildAdherenceSummaryReport([]).rows).toEqual([]);
  });
});

describe('buildViolationAuditReport', () => {
  const shift = (startIso: string, endIso: string) => ({
    employeeId: 'emp-1',
    start: new Date(startIso),
    end: new Date(endIso),
  });

  it('returns a header-only table when no rule is active, not an error', () => {
    const table = buildViolationAuditReport(ComplianceRuleType.REST_PERIOD_MINIMUM, null, [
      { employeeId: 'emp-1', shifts: [shift('2026-06-01T09:00:00Z', '2026-06-01T17:00:00Z')] },
    ]);
    expect(table.rows).toEqual([]);
  });

  it('produces one row per violation, tagged with the employee and the rule citation', () => {
    const table = buildViolationAuditReport(
      ComplianceRuleType.REST_PERIOD_MINIMUM,
      { citation: 'Cal. Labor Code Section 226.7', definition: { minRestHoursBetweenShifts: 10 } },
      [
        {
          employeeId: 'emp-1',
          shifts: [
            shift('2026-06-01T09:00:00Z', '2026-06-01T17:00:00Z'),
            shift('2026-06-02T01:00:00Z', '2026-06-02T09:00:00Z'),
          ],
        },
        { employeeId: 'emp-2', shifts: [shift('2026-06-01T09:00:00Z', '2026-06-01T17:00:00Z')] },
      ],
    );
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0][0]).toBe('emp-1');
    expect(table.rows[0][1]).toBe(ComplianceRuleType.REST_PERIOD_MINIMUM);
    expect(table.rows[0][3]).toBe('Cal. Labor Code Section 226.7');
  });
});

describe('buildRegulatorExportReport', () => {
  it('combines active rules and both audits into one discriminated table', () => {
    const overtimeAudit = buildViolationAuditReport(
      ComplianceRuleType.OVERTIME_THRESHOLD,
      { citation: 'Overtime citation', definition: { dailyThresholdHours: 8 } },
      [
        {
          employeeId: 'emp-1',
          shifts: [
            { employeeId: 'emp-1', start: new Date('2026-06-01T09:00:00Z'), end: new Date('2026-06-01T20:00:00Z') },
          ],
        },
      ],
    );
    const restPeriodAudit = buildViolationAuditReport(ComplianceRuleType.REST_PERIOD_MINIMUM, null, []);

    const table = buildRegulatorExportReport(
      [{ ruleType: ComplianceRuleType.OVERTIME_THRESHOLD, citation: 'Overtime citation', effectiveFrom: '2026-01-01' }],
      overtimeAudit,
      restPeriodAudit,
    );

    expect(table.headers).toEqual(['recordType', 'ruleType', 'citation', 'employeeId', 'detail']);
    expect(table.rows).toEqual([
      ['active_rule', ComplianceRuleType.OVERTIME_THRESHOLD, 'Overtime citation', '', 'effective from 2026-01-01'],
      [
        'violation',
        ComplianceRuleType.OVERTIME_THRESHOLD,
        'Overtime citation',
        'emp-1',
        'worked 11.00h on 2026-06-01 (daily threshold 8h)',
      ],
    ]);
  });
});
