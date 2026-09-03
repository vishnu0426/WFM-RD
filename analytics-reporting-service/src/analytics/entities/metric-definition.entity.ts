import { Column, Entity, PrimaryColumn } from 'typeorm';

export enum MetricCategory {
  ATTENDANCE = 'attendance',
  OCCUPANCY = 'occupancy',
  COST = 'cost',
  PERFORMANCE = 'performance',
  FORECAST_ACCURACY = 'forecast_accuracy',
}

export enum MetricCostTier {
  CHEAP = 'cheap',
  MODERATE = 'moderate',
  EXPENSIVE = 'expensive',
}

/**
 * §2.1/§2.3 rule 2 - `tenantId: null` means a global/platform-default
 * metric, same nullable-tenant-as-platform-default shape ADR-0095
 * established for `ComplianceRule`/`RetentionPolicy`: a tenant connection
 * may read the platform defaults plus its own tenant-authored metrics, but
 * may never write a null-tenant row itself.
 *
 * `validatedAt`/`estimatedCostTier` are the §0.5/§2.3 rule 2 progressive-
 * delivery gate: a tenant-authored `calculationDefinition` must be
 * dry-run-validated and cost-tiered (Phase 5) before `estimatedCostTier`
 * can be anything other than null, and an `'expensive'` tier restricts a
 * metric to the async report path (§4.2's export job), never a live
 * dashboard widget that other users load repeatedly. Nothing in this phase
 * populates either column - both are real, nullable columns now so Phase
 * 5's validation pipeline has a proven place to write into.
 */
@Entity({ name: 'metric_definition', schema: 'analytics' })
export class MetricDefinition {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id', nullable: true })
  tenantId!: string | null;

  @Column('varchar', { name: 'name' })
  name!: string;

  @Column('jsonb', { name: 'calculation_definition' })
  calculationDefinition!: Record<string, unknown>;

  @Column('varchar', { name: 'category' })
  category!: MetricCategory;

  @Column('timestamptz', { name: 'validated_at', nullable: true })
  validatedAt!: Date | null;

  @Column('varchar', { name: 'estimated_cost_tier', nullable: true })
  estimatedCostTier!: MetricCostTier | null;

  @Column('timestamptz', { name: 'created_at' })
  createdAt!: Date;

  @Column('timestamptz', { name: 'updated_at' })
  updatedAt!: Date;
}
