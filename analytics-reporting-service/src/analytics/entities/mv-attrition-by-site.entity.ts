import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Phase 3: `org.employees.termination_date` joined to the nearest
 * `org.org_units` ancestor of `type = 'site'`. `terminationsCount` only -
 * no headcount/rate column (a real attrition rate needs a historical
 * point-in-time headcount denominator this phase does not build - see the
 * migration that creates this table). Written by
 * `MvAttritionBySiteRefreshJobService` via `MIGRATOR_PG_POOL` raw SQL, not
 * this entity's own repository - this class exists for Phase 4's
 * `agno_analytics_app`-scoped query-engine reads.
 */
@Entity({ name: 'mv_attrition_by_site', schema: 'analytics_mv' })
export class MvAttritionBySite {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'site_org_unit_id' })
  siteOrgUnitId!: string;

  @Column('timestamptz', { name: 'period_start' })
  periodStart!: Date;

  @Column('timestamptz', { name: 'period_end' })
  periodEnd!: Date;

  @Column('integer', { name: 'terminations_count' })
  terminationsCount!: number;

  @Column('timestamptz', { name: 'computed_at' })
  computedAt!: Date;
}
