import { ComplianceRuleGrpcController } from '../../../src/grpc/controllers/compliance-rule-grpc.controller';
import { ComplianceRuleService } from '../../../src/compliance/compliance-rule.service';
import { ComplianceRuleType } from '../../../src/compliance/entities/compliance-rule.entity';

describe('ComplianceRuleGrpcController', () => {
  let controller: ComplianceRuleGrpcController;
  let getActiveRule: jest.Mock;

  beforeEach(() => {
    getActiveRule = jest.fn();
    controller = new ComplianceRuleGrpcController({ getActiveRule } as unknown as ComplianceRuleService);
  });

  describe('getActiveRule', () => {
    it('returns found: false for an unknown rule_type, without calling the service', async () => {
      const result = await controller.getActiveRule({
        tenantId: 't1',
        jurisdiction: 'US-CA',
        ruleType: 'not_a_real_rule_type',
        asOf: '',
      });
      expect(result.found).toBe(false);
      expect(getActiveRule).not.toHaveBeenCalled();
    });

    it('returns found: false when the service finds nothing', async () => {
      getActiveRule.mockResolvedValue(null);
      const result = await controller.getActiveRule({
        tenantId: 't1',
        jurisdiction: 'US-CA',
        ruleType: ComplianceRuleType.REST_PERIOD_MINIMUM,
        asOf: '',
      });
      expect(result.found).toBe(false);
    });

    it('maps a found rule to the wire response, including isPlatformDefault derived from a null tenantId', async () => {
      getActiveRule.mockResolvedValue({
        id: 'rule-1',
        tenantId: null,
        jurisdiction: 'US-CA',
        ruleType: ComplianceRuleType.REST_PERIOD_MINIMUM,
        definition: { minRestHoursBetweenShifts: 10 },
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
        version: 1,
        citation: 'Cal. Labor Code Section 226.7',
      });

      const result = await controller.getActiveRule({
        tenantId: 't1',
        jurisdiction: 'US-CA',
        ruleType: ComplianceRuleType.REST_PERIOD_MINIMUM,
        asOf: '',
      });

      expect(result).toEqual({
        found: true,
        id: 'rule-1',
        jurisdiction: 'US-CA',
        ruleType: ComplianceRuleType.REST_PERIOD_MINIMUM,
        definitionJson: JSON.stringify({ minRestHoursBetweenShifts: 10 }),
        effectiveFrom: '2026-01-01',
        effectiveTo: '',
        version: 1,
        citation: 'Cal. Labor Code Section 226.7',
        isPlatformDefault: true,
      });
    });

    it('defaults asOf to now when the request omits it, and passes through an explicit asOf otherwise', async () => {
      getActiveRule.mockResolvedValue(null);
      await controller.getActiveRule({
        tenantId: 't1',
        jurisdiction: 'US',
        ruleType: ComplianceRuleType.UNION_RULE,
        asOf: '2020-01-01T00:00:00Z',
      });
      const passedAsOf = getActiveRule.mock.calls[0][3];
      expect(passedAsOf).toEqual(new Date('2020-01-01T00:00:00Z'));
    });
  });

  describe('validatePolicyAgainstFloor', () => {
    it('returns floorNotFound: true and valid: true when no floor exists, without attempting any comparison', async () => {
      getActiveRule.mockResolvedValue(null);
      const result = await controller.validatePolicyAgainstFloor({
        tenantId: 't1',
        jurisdiction: 'US-CA',
        ruleType: ComplianceRuleType.REST_PERIOD_MINIMUM,
        policyDefinitionJson: '{"minRestHoursBetweenShifts":5}',
      });
      expect(result).toEqual({ valid: true, violations: [], floorNotFound: true });
    });

    it('returns a clean violation, not a thrown error, for invalid policy_definition_json', async () => {
      getActiveRule.mockResolvedValue({
        id: 'r1',
        tenantId: null,
        jurisdiction: 'US-CA',
        ruleType: ComplianceRuleType.REST_PERIOD_MINIMUM,
        definition: { minRestHoursBetweenShifts: 10 },
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
        version: 1,
        citation: 'cite',
      });
      const result = await controller.validatePolicyAgainstFloor({
        tenantId: 't1',
        jurisdiction: 'US-CA',
        ruleType: ComplianceRuleType.REST_PERIOD_MINIMUM,
        policyDefinitionJson: 'not json',
      });
      expect(result.valid).toBe(false);
      expect(result.floorNotFound).toBe(false);
      expect(result.violations[0]).toContain('not valid JSON');
    });

    it('runs the real comparator against the resolved floor and reports floorNotFound: false', async () => {
      getActiveRule.mockResolvedValue({
        id: 'r1',
        tenantId: null,
        jurisdiction: 'US-CA',
        ruleType: ComplianceRuleType.REST_PERIOD_MINIMUM,
        definition: { minRestHoursBetweenShifts: 10 },
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
        version: 1,
        citation: 'cite',
      });
      const result = await controller.validatePolicyAgainstFloor({
        tenantId: 't1',
        jurisdiction: 'US-CA',
        ruleType: ComplianceRuleType.REST_PERIOD_MINIMUM,
        policyDefinitionJson: '{"minRestHoursBetweenShifts":5}',
      });
      expect(result.valid).toBe(false);
      expect(result.floorNotFound).toBe(false);
      expect(result.violations).toHaveLength(1);
    });

    it('returns floorNotFound: true for an unknown rule_type, without calling the service', async () => {
      const result = await controller.validatePolicyAgainstFloor({
        tenantId: 't1',
        jurisdiction: 'US-CA',
        ruleType: 'not_a_real_rule_type',
        policyDefinitionJson: '{}',
      });
      expect(result).toEqual({ valid: true, violations: [], floorNotFound: true });
      expect(getActiveRule).not.toHaveBeenCalled();
    });
  });
});
