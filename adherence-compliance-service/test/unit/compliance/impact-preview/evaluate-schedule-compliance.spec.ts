import {
  findViolations,
  isCompliant,
  SimulatedShift,
} from '../../../../src/compliance/impact-preview/evaluate-schedule-compliance';
import { ComplianceRuleType } from '../../../../src/compliance/entities/compliance-rule.entity';

function shift(startIso: string, endIso: string, employeeId = 'emp-1'): SimulatedShift {
  return { employeeId, start: new Date(startIso), end: new Date(endIso) };
}

describe('isCompliant', () => {
  describe('overtime_threshold', () => {
    it('is compliant when no field in the definition applies', () => {
      const shifts = [shift('2026-06-01T09:00:00Z', '2026-06-01T20:00:00Z')];
      expect(isCompliant(ComplianceRuleType.OVERTIME_THRESHOLD, {}, shifts)).toBe(true);
    });

    it('flags a single day exceeding dailyThresholdHours', () => {
      const shifts = [shift('2026-06-01T09:00:00Z', '2026-06-01T20:00:00Z')]; // 11h
      expect(isCompliant(ComplianceRuleType.OVERTIME_THRESHOLD, { dailyThresholdHours: 10 }, shifts)).toBe(false);
    });

    it('does not flag a day at or under the threshold', () => {
      const shifts = [shift('2026-06-01T09:00:00Z', '2026-06-01T19:00:00Z')]; // 10h
      expect(isCompliant(ComplianceRuleType.OVERTIME_THRESHOLD, { dailyThresholdHours: 10 }, shifts)).toBe(true);
    });

    it('flags a week (Monday-start) whose summed hours exceed weeklyThresholdHours, across separate shifts', () => {
      // Monday 2026-06-01 through Friday 2026-06-05, 9h/day = 45h.
      const shifts = [
        shift('2026-06-01T09:00:00Z', '2026-06-01T18:00:00Z'),
        shift('2026-06-02T09:00:00Z', '2026-06-02T18:00:00Z'),
        shift('2026-06-03T09:00:00Z', '2026-06-03T18:00:00Z'),
        shift('2026-06-04T09:00:00Z', '2026-06-04T18:00:00Z'),
        shift('2026-06-05T09:00:00Z', '2026-06-05T18:00:00Z'),
      ];
      expect(isCompliant(ComplianceRuleType.OVERTIME_THRESHOLD, { weeklyThresholdHours: 40 }, shifts)).toBe(false);
    });

    it('does not let a following week borrow hours from the previous one', () => {
      const shifts = [
        shift('2026-06-05T09:00:00Z', '2026-06-05T18:00:00Z'), // Friday, week of 06-01
        shift('2026-06-08T09:00:00Z', '2026-06-08T18:00:00Z'), // Monday, week of 06-08
      ];
      expect(isCompliant(ComplianceRuleType.OVERTIME_THRESHOLD, { weeklyThresholdHours: 40 }, shifts)).toBe(true);
    });
  });

  describe('rest_period_minimum', () => {
    it('is compliant with no minRestHoursBetweenShifts field', () => {
      expect(isCompliant(ComplianceRuleType.REST_PERIOD_MINIMUM, {}, [])).toBe(true);
    });

    it('flags two shifts with less than the required rest between them', () => {
      const shifts = [
        shift('2026-06-01T09:00:00Z', '2026-06-01T17:00:00Z'),
        shift('2026-06-01T20:00:00Z', '2026-06-02T04:00:00Z'), // 3h gap
      ];
      expect(isCompliant(ComplianceRuleType.REST_PERIOD_MINIMUM, { minRestHoursBetweenShifts: 10 }, shifts)).toBe(
        false,
      );
    });

    it('flags overlapping shifts (negative gap) the same as an insufficient one', () => {
      const shifts = [
        shift('2026-06-01T09:00:00Z', '2026-06-01T17:00:00Z'),
        shift('2026-06-01T16:00:00Z', '2026-06-02T00:00:00Z'),
      ];
      expect(isCompliant(ComplianceRuleType.REST_PERIOD_MINIMUM, { minRestHoursBetweenShifts: 10 }, shifts)).toBe(
        false,
      );
    });

    it('is compliant when the gap meets the requirement exactly, regardless of input order', () => {
      const shifts = [
        shift('2026-06-02T03:00:00Z', '2026-06-02T11:00:00Z'),
        shift('2026-06-01T09:00:00Z', '2026-06-01T17:00:00Z'), // out of order on purpose
      ];
      expect(isCompliant(ComplianceRuleType.REST_PERIOD_MINIMUM, { minRestHoursBetweenShifts: 10 }, shifts)).toBe(true);
    });
  });

  describe('max_consecutive_days', () => {
    it('is compliant with no maxConsecutiveWorkingDays field', () => {
      expect(isCompliant(ComplianceRuleType.MAX_CONSECUTIVE_DAYS, {}, [])).toBe(true);
    });

    it('flags a run of consecutive worked days longer than the cap', () => {
      const days = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-06'];
      const shifts = days.map((d) => shift(`${d}T09:00:00Z`, `${d}T17:00:00Z`));
      expect(isCompliant(ComplianceRuleType.MAX_CONSECUTIVE_DAYS, { maxConsecutiveWorkingDays: 5 }, shifts)).toBe(
        false,
      );
    });

    it('does not flag a run exactly at the cap', () => {
      const days = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05'];
      const shifts = days.map((d) => shift(`${d}T09:00:00Z`, `${d}T17:00:00Z`));
      expect(isCompliant(ComplianceRuleType.MAX_CONSECUTIVE_DAYS, { maxConsecutiveWorkingDays: 5 }, shifts)).toBe(true);
    });

    it('does not flag two separate runs each within the cap, split by a rest day', () => {
      const days = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-05', '2026-06-06', '2026-06-07'];
      const shifts = days.map((d) => shift(`${d}T09:00:00Z`, `${d}T17:00:00Z`));
      expect(isCompliant(ComplianceRuleType.MAX_CONSECUTIVE_DAYS, { maxConsecutiveWorkingDays: 3 }, shifts)).toBe(true);
    });

    it('treats multiple shifts on the same day as one worked day, not two', () => {
      const shifts = [
        shift('2026-06-01T02:00:00Z', '2026-06-01T06:00:00Z'),
        shift('2026-06-01T14:00:00Z', '2026-06-01T18:00:00Z'),
      ];
      expect(isCompliant(ComplianceRuleType.MAX_CONSECUTIVE_DAYS, { maxConsecutiveWorkingDays: 0 }, shifts)).toBe(
        false,
      );
    });
  });

  describe('union_rule', () => {
    it('is compliant with neither shift-length field set', () => {
      expect(
        isCompliant(ComplianceRuleType.UNION_RULE, {}, [shift('2026-06-01T09:00:00Z', '2026-06-01T09:05:00Z')]),
      ).toBe(true);
    });

    it('flags a shift shorter than minShiftLengthMinutes', () => {
      const shifts = [shift('2026-06-01T09:00:00Z', '2026-06-01T10:00:00Z')]; // 60min
      expect(isCompliant(ComplianceRuleType.UNION_RULE, { minShiftLengthMinutes: 120 }, shifts)).toBe(false);
    });

    it('flags a shift longer than maxShiftLengthMinutes', () => {
      const shifts = [shift('2026-06-01T09:00:00Z', '2026-06-01T20:00:00Z')]; // 660min
      expect(isCompliant(ComplianceRuleType.UNION_RULE, { maxShiftLengthMinutes: 600 }, shifts)).toBe(false);
    });

    it('ignores mandatoryBreakAfterHours/mandatoryBreakMinutes - no schedule-derivable break signal', () => {
      const shifts = [shift('2026-06-01T09:00:00Z', '2026-06-01T20:00:00Z')];
      expect(
        isCompliant(
          ComplianceRuleType.UNION_RULE,
          { mandatoryBreakAfterHours: 1, mandatoryBreakMinutes: 9999 },
          shifts,
        ),
      ).toBe(true);
    });

    it('is compliant when every shift is within [min, max]', () => {
      const shifts = [shift('2026-06-01T09:00:00Z', '2026-06-01T17:00:00Z')]; // 480min
      expect(
        isCompliant(ComplianceRuleType.UNION_RULE, { minShiftLengthMinutes: 240, maxShiftLengthMinutes: 600 }, shifts),
      ).toBe(true);
    });
  });

  describe('break_requirement', () => {
    it('is always compliant - no schedule-derivable signal exists for this rule type', () => {
      const shifts = [shift('2026-06-01T09:00:00Z', '2026-06-01T20:00:00Z')];
      expect(isCompliant(ComplianceRuleType.BREAK_REQUIREMENT, { anything: 1 }, shifts)).toBe(true);
    });
  });
});

describe('findViolations', () => {
  it('returns [] whenever isCompliant would be true', () => {
    expect(findViolations(ComplianceRuleType.REST_PERIOD_MINIMUM, {}, [])).toEqual([]);
  });

  it('describes an overtime violation with the actual hours, the date, and the threshold', () => {
    const shifts = [shift('2026-06-01T09:00:00Z', '2026-06-01T20:00:00Z')]; // 11h
    const violations = findViolations(ComplianceRuleType.OVERTIME_THRESHOLD, { dailyThresholdHours: 10 }, shifts);
    expect(violations).toEqual(['worked 11.00h on 2026-06-01 (daily threshold 10h)']);
  });

  it('describes a rest-period violation with the actual gap and the two shift boundaries', () => {
    const shifts = [
      shift('2026-06-01T09:00:00Z', '2026-06-01T17:00:00Z'),
      shift('2026-06-01T20:00:00Z', '2026-06-02T04:00:00Z'),
    ];
    const violations = findViolations(
      ComplianceRuleType.REST_PERIOD_MINIMUM,
      { minRestHoursBetweenShifts: 10 },
      shifts,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('3.00h rest');
    expect(violations[0]).toContain('minimum 10h');
  });

  it('reports one violation per contiguous over-cap run, not one per overlapping sliding window', () => {
    const days = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-06', '2026-06-07'];
    const shifts = days.map((d) => shift(`${d}T09:00:00Z`, `${d}T17:00:00Z`));
    const violations = findViolations(
      ComplianceRuleType.MAX_CONSECUTIVE_DAYS,
      { maxConsecutiveWorkingDays: 5 },
      shifts,
    );
    expect(violations).toEqual(['worked 7 consecutive days from 2026-06-01 to 2026-06-07 (max 5)']);
  });

  it('reports each of two separate over-cap runs independently', () => {
    const runA = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04'];
    const runB = ['2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13'];
    const shifts = [...runA, ...runB].map((d) => shift(`${d}T09:00:00Z`, `${d}T17:00:00Z`));
    const violations = findViolations(
      ComplianceRuleType.MAX_CONSECUTIVE_DAYS,
      { maxConsecutiveWorkingDays: 3 },
      shifts,
    );
    expect(violations).toEqual([
      'worked 4 consecutive days from 2026-06-01 to 2026-06-04 (max 3)',
      'worked 4 consecutive days from 2026-06-10 to 2026-06-13 (max 3)',
    ]);
  });

  it('describes a union_rule shift-length violation with the actual minutes and the bound', () => {
    const shifts = [shift('2026-06-01T09:00:00Z', '2026-06-01T10:00:00Z')]; // 60min
    const violations = findViolations(ComplianceRuleType.UNION_RULE, { minShiftLengthMinutes: 120 }, shifts);
    expect(violations).toEqual(['shift starting 2026-06-01T09:00:00.000Z is 60min, below the minimum 120min']);
  });
});
