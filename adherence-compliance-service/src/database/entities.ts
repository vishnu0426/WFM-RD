import { AdherenceScore } from '../adherence/entities/adherence-score.entity';
import { OccupancyRecord } from '../adherence/entities/occupancy-record.entity';
import { ShrinkageRecord } from '../adherence/entities/shrinkage-record.entity';
import { ComplianceRule } from '../compliance/entities/compliance-rule.entity';
import { ComplianceReport } from '../compliance/entities/compliance-report.entity';
import { RuleChangeImpactPreview } from '../compliance/entities/rule-change-impact-preview.entity';
import { RetentionPolicy } from '../compliance/entities/retention-policy.entity';

/**
 * Single source of truth for "every entity in this service," consumed by
 * both the NestJS `TypeOrmModule` registration and the CLI `DataSource`
 * used for migrations - same convention as every other service's own
 * `src/database/entities.ts` in this platform.
 */
export const entities = [
  AdherenceScore,
  OccupancyRecord,
  ShrinkageRecord,
  ComplianceRule,
  ComplianceReport,
  RuleChangeImpactPreview,
  RetentionPolicy,
];

export {
  AdherenceScore,
  OccupancyRecord,
  ShrinkageRecord,
  ComplianceRule,
  ComplianceReport,
  RuleChangeImpactPreview,
  RetentionPolicy,
};
