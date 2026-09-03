import 'reflect-metadata';
import { getMetadataArgsStorage } from 'typeorm';
import { AdherenceScorePeriodType } from '../../src/adherence/entities/adherence-score.entity';
import { ShrinkageCategory } from '../../src/adherence/entities/shrinkage-record.entity';
import {
  ComplianceRule,
  ComplianceRuleStatus,
  ComplianceRuleType,
} from '../../src/compliance/entities/compliance-rule.entity';
import { ComplianceReportStatus, ComplianceReportType } from '../../src/compliance/entities/compliance-report.entity';
import { entities } from '../../src/database/entities';

/**
 * Verifies the TypeORM entity classes agree with the §2.1 DDL and the
 * ADR-0003 enum-representation convention (a real TS enum backs every
 * varchar+CHECK column) - catches an entity/migration drift that a
 * TypeScript compile alone would not.
 */
describe('database entities', () => {
  it('registers all seven §2.1/§5a/§5b entities, scoped to the compliance schema', () => {
    expect(entities).toHaveLength(7);
    const entitySet = new Set<unknown>(entities);
    const tables = getMetadataArgsStorage().tables.filter((t) => entitySet.has(t.target));
    expect(tables).toHaveLength(7);
    for (const table of tables) {
      expect(table.schema).toBe('compliance');
    }
  });

  it("AdherenceScorePeriodType matches §2.1's enum exactly", () => {
    expect(Object.values(AdherenceScorePeriodType).sort()).toEqual(['shift', 'day', 'week', 'month'].sort());
  });

  it("ShrinkageCategory matches §2.1's enum exactly", () => {
    expect(Object.values(ShrinkageCategory).sort()).toEqual(
      ['leave', 'training', 'meeting', 'break_overage', 'absence', 'other'].sort(),
    );
  });

  it("ComplianceRuleType matches §2.1's enum exactly", () => {
    expect(Object.values(ComplianceRuleType).sort()).toEqual(
      ['overtime_threshold', 'rest_period_minimum', 'max_consecutive_days', 'break_requirement', 'union_rule'].sort(),
    );
  });

  it("ComplianceRuleStatus matches §5a's added status field exactly", () => {
    expect(Object.values(ComplianceRuleStatus).sort()).toEqual(
      ['pending_review', 'active', 'superseded', 'rejected'].sort(),
    );
  });

  it("ComplianceReportType matches §2.1's enum exactly", () => {
    expect(Object.values(ComplianceReportType).sort()).toEqual(
      ['adherence_summary', 'overtime_audit', 'rest_period_audit', 'regulator_export'].sort(),
    );
  });

  it('ComplianceReportStatus matches the status field added beyond §2.1 for async generation', () => {
    expect(Object.values(ComplianceReportStatus).sort()).toEqual(['pending', 'completed', 'failed'].sort());
  });

  it('ComplianceRule.tenantId is nullable at the column-metadata level (§2.2 rule 3 platform-default shape)', () => {
    const column = getMetadataArgsStorage().columns.find(
      (c) => c.target === ComplianceRule && c.propertyName === 'tenantId',
    );
    expect(column).toBeDefined();
    expect(column!.options.nullable).toBe(true);
  });
});
