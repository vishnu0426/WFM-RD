import { ComplianceRuleType } from '../../../src/compliance/entities/compliance-rule.entity';
import { validatePolicyAgainstFloor } from '../../../src/compliance/validate-policy-against-floor';

describe('validatePolicyAgainstFloor', () => {
  describe('rest_period_minimum (higher is stricter)', () => {
    const floor = { minRestHoursBetweenShifts: 10 };

    it('passes when the policy meets the floor exactly', () => {
      expect(
        validatePolicyAgainstFloor(ComplianceRuleType.REST_PERIOD_MINIMUM, { minRestHoursBetweenShifts: 10 }, floor),
      ).toEqual({
        valid: true,
        violations: [],
      });
    });

    it('passes when the policy is stricter than the floor', () => {
      const result = validatePolicyAgainstFloor(
        ComplianceRuleType.REST_PERIOD_MINIMUM,
        { minRestHoursBetweenShifts: 12 },
        floor,
      );
      expect(result.valid).toBe(true);
    });

    it('fails when the policy is looser than the floor', () => {
      const result = validatePolicyAgainstFloor(
        ComplianceRuleType.REST_PERIOD_MINIMUM,
        { minRestHoursBetweenShifts: 8 },
        floor,
      );
      expect(result.valid).toBe(false);
      expect(result.violations).toEqual([
        "minRestHoursBetweenShifts=8 is less protective than the jurisdiction's floor (minRestHoursBetweenShifts=10)",
      ]);
    });

    it('fails when the policy omits a field the floor requires', () => {
      const result = validatePolicyAgainstFloor(ComplianceRuleType.REST_PERIOD_MINIMUM, {}, floor);
      expect(result.valid).toBe(false);
      expect(result.violations[0]).toContain('missing from this policy');
    });
  });

  describe('max_consecutive_days (lower is stricter)', () => {
    it('fails when the policy allows more consecutive days than the floor', () => {
      const result = validatePolicyAgainstFloor(
        ComplianceRuleType.MAX_CONSECUTIVE_DAYS,
        { maxConsecutiveWorkingDays: 8 },
        { maxConsecutiveWorkingDays: 6 },
      );
      expect(result.valid).toBe(false);
    });

    it('passes when the policy allows fewer consecutive days than the floor', () => {
      const result = validatePolicyAgainstFloor(
        ComplianceRuleType.MAX_CONSECUTIVE_DAYS,
        { maxConsecutiveWorkingDays: 5 },
        { maxConsecutiveWorkingDays: 6 },
      );
      expect(result.valid).toBe(true);
    });
  });

  describe('overtime_threshold (mixed directions)', () => {
    const floor = { dailyThresholdHours: 8, weeklyThresholdHours: 40, multiplier: 1.5 };

    it('passes a policy that is at least as protective on every field', () => {
      const result = validatePolicyAgainstFloor(
        ComplianceRuleType.OVERTIME_THRESHOLD,
        { dailyThresholdHours: 8, weeklyThresholdHours: 38, multiplier: 1.5 },
        floor,
      );
      expect(result.valid).toBe(true);
    });

    it('flags a lower multiplier (less overtime pay) as a violation, independent of the threshold fields', () => {
      const result = validatePolicyAgainstFloor(
        ComplianceRuleType.OVERTIME_THRESHOLD,
        { dailyThresholdHours: 8, weeklyThresholdHours: 40, multiplier: 1.25 },
        floor,
      );
      expect(result.valid).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]).toContain('multiplier=1.25');
    });

    it('reports every violated field, not just the first', () => {
      const result = validatePolicyAgainstFloor(
        ComplianceRuleType.OVERTIME_THRESHOLD,
        { dailyThresholdHours: 9, weeklyThresholdHours: 42, multiplier: 1.5 },
        floor,
      );
      expect(result.violations).toHaveLength(2);
    });
  });

  describe('union_rule (four independently-directioned fields)', () => {
    const floor = {
      minShiftLengthMinutes: 180,
      maxShiftLengthMinutes: 600,
      mandatoryBreakAfterHours: 5,
      mandatoryBreakMinutes: 30,
    };

    it('passes a policy that matches the floor on every field', () => {
      const result = validatePolicyAgainstFloor(ComplianceRuleType.UNION_RULE, floor, floor);
      expect(result.valid).toBe(true);
    });

    it('fails a shorter guaranteed minimum shift length', () => {
      const result = validatePolicyAgainstFloor(
        ComplianceRuleType.UNION_RULE,
        { ...floor, minShiftLengthMinutes: 120 },
        floor,
      );
      expect(result.valid).toBe(false);
    });

    it('fails a mandatory break required later than the floor allows', () => {
      const result = validatePolicyAgainstFloor(
        ComplianceRuleType.UNION_RULE,
        { ...floor, mandatoryBreakAfterHours: 6 },
        floor,
      );
      expect(result.valid).toBe(false);
    });
  });

  it('ignores a field the floor does not itself constrain', () => {
    const result = validatePolicyAgainstFloor(
      ComplianceRuleType.UNION_RULE,
      { minShiftLengthMinutes: 180 },
      { minShiftLengthMinutes: 180 }, // floor has no maxShiftLengthMinutes opinion
    );
    expect(result.valid).toBe(true);
  });

  it('has no field directions for break_requirement (no EmploymentPolicy counterpart exists)', () => {
    const result = validatePolicyAgainstFloor(ComplianceRuleType.BREAK_REQUIREMENT, {}, { anything: 1 });
    expect(result).toEqual({ valid: true, violations: [] });
  });

  it('treats a non-numeric policy value as a violation rather than throwing', () => {
    const result = validatePolicyAgainstFloor(
      ComplianceRuleType.REST_PERIOD_MINIMUM,
      { minRestHoursBetweenShifts: 'not-a-number' },
      { minRestHoursBetweenShifts: 10 },
    );
    expect(result.valid).toBe(false);
    expect(result.violations[0]).toContain('must be a number');
  });
});
