import {
  ComplianceRule,
  ComplianceRuleStatus,
  ComplianceRuleType,
} from '../../../src/compliance/entities/compliance-rule.entity';
import { resolveEffectiveRules } from '../../../src/compliance/resolve-effective-rules';

function rule(overrides: Partial<ComplianceRule>): ComplianceRule {
  return Object.assign(new ComplianceRule(), {
    id: 'id',
    tenantId: null,
    jurisdiction: 'US-CA',
    ruleType: ComplianceRuleType.REST_PERIOD_MINIMUM,
    definition: {},
    effectiveFrom: '2020-01-01',
    effectiveTo: null,
    version: 1,
    citation: 'Cal. Labor Code Section 226.7',
    status: ComplianceRuleStatus.ACTIVE,
    activationDelayUntil: null,
    createdAt: new Date('2020-01-01T00:00:00Z'),
    activatedAt: new Date('2020-01-01T00:00:00Z'),
    ...overrides,
  });
}

describe('resolveEffectiveRules', () => {
  const asOf = new Date('2026-06-01T00:00:00Z');

  it('excludes a rule that is not status=active', () => {
    const rules = [rule({ status: ComplianceRuleStatus.PENDING_REVIEW })];
    expect(resolveEffectiveRules(rules, asOf)).toEqual([]);
  });

  it('excludes a rule whose effectiveFrom is in the future', () => {
    const rules = [rule({ effectiveFrom: '2027-01-01' })];
    expect(resolveEffectiveRules(rules, asOf)).toEqual([]);
  });

  it('excludes a rule whose effectiveTo has already passed', () => {
    const rules = [rule({ effectiveTo: '2025-12-31' })];
    expect(resolveEffectiveRules(rules, asOf)).toEqual([]);
  });

  it("§5a/§0.5: excludes a rule whose activationDelayUntil hasn't arrived yet, even though status is already 'active'", () => {
    const rules = [rule({ activationDelayUntil: new Date('2027-01-01T00:00:00Z') })];
    expect(resolveEffectiveRules(rules, asOf)).toEqual([]);
  });

  it('includes a rule whose activationDelayUntil has already passed', () => {
    const rules = [rule({ id: 'r1', activationDelayUntil: new Date('2025-01-01T00:00:00Z') })];
    expect(resolveEffectiveRules(rules, asOf).map((r) => r.id)).toEqual(['r1']);
  });

  it('§2.2 rule 3: a tenant-scoped override always wins over the platform default for the same ruleType', () => {
    const platformDefault = rule({ id: 'platform', tenantId: null, version: 5 });
    const tenantOverride = rule({ id: 'tenant', tenantId: 'tenant-1', version: 1 });
    const resolved = resolveEffectiveRules([platformDefault, tenantOverride], asOf);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].id).toBe('tenant');
  });

  it('among two rows of the same scope (both tenant-scoped or both platform-default), the higher version wins', () => {
    const v1 = rule({ id: 'v1', tenantId: 'tenant-1', version: 1 });
    const v2 = rule({ id: 'v2', tenantId: 'tenant-1', version: 2 });
    const resolved = resolveEffectiveRules([v1, v2], asOf);
    expect(resolved.map((r) => r.id)).toEqual(['v2']);
  });

  it('returns at most one row per ruleType, across multiple rule types independently', () => {
    const overtime = rule({ id: 'overtime', ruleType: ComplianceRuleType.OVERTIME_THRESHOLD });
    const restPeriod = rule({ id: 'rest', ruleType: ComplianceRuleType.REST_PERIOD_MINIMUM });
    const resolved = resolveEffectiveRules([overtime, restPeriod], asOf);
    expect(resolved.map((r) => r.id).sort()).toEqual(['overtime', 'rest']);
  });

  describe('GAP-03 fix (enterprise readiness audit, 2026-08-18): historical resolution against superseded rows', () => {
    it('resolves a superseded rule for a historical asOf that predates the current active rule, instead of finding nothing', () => {
      // activateRule flips the prior row to `superseded` but never touches
      // its effectiveFrom/effectiveTo (see resolve-effective-rules.ts's own
      // doc comment) - v1 genuinely covered 2025-01-01..2026-01-01 and
      // still says so.
      const v1 = rule({
        id: 'v1',
        version: 1,
        status: ComplianceRuleStatus.SUPERSEDED,
        effectiveFrom: '2025-01-01',
        effectiveTo: null,
      });
      const v2 = rule({
        id: 'v2',
        version: 2,
        status: ComplianceRuleStatus.ACTIVE,
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
      });
      const historicalAsOf = new Date('2025-06-01T00:00:00Z');

      const resolved = resolveEffectiveRules([v1, v2], historicalAsOf);

      expect(resolved.map((r) => r.id)).toEqual(['v1']);
    });

    it('still resolves to the current active rule (not the superseded one) for a present-day asOf, without ever backfilling effectiveTo', () => {
      const v1 = rule({
        id: 'v1',
        version: 1,
        status: ComplianceRuleStatus.SUPERSEDED,
        effectiveFrom: '2025-01-01',
        effectiveTo: null, // never backfilled - both rows' windows overlap for `asOf`
      });
      const v2 = rule({
        id: 'v2',
        version: 2,
        status: ComplianceRuleStatus.ACTIVE,
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
      });

      const resolved = resolveEffectiveRules([v1, v2], asOf);

      expect(resolved.map((r) => r.id)).toEqual(['v2']);
    });

    it('never resolves a rejected or still-pending-review row, regardless of its effective window', () => {
      const rejected = rule({ id: 'rejected', status: ComplianceRuleStatus.REJECTED, effectiveFrom: '2020-01-01' });
      const pending = rule({
        id: 'pending',
        status: ComplianceRuleStatus.PENDING_REVIEW,
        effectiveFrom: '2020-01-01',
      });
      expect(resolveEffectiveRules([rejected], asOf)).toEqual([]);
      expect(resolveEffectiveRules([pending], asOf)).toEqual([]);
    });
  });
});
