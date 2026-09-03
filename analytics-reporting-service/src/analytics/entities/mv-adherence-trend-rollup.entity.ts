import { Column, Entity, PrimaryColumn } from 'typeorm';

export enum MvAdherenceTrendRollupPeriodType {
  SHIFT = 'shift',
  DAY = 'day',
  WEEK = 'week',
  MONTH = 'month',
}

/**
 * Phase 2 (ADR-0108): re-aggregates Module 08's `AdherenceScore` across
 * employees, grouped by the same `(tenantId, periodType, periodStart,
 * periodEnd)` triple Module 08's own rollup already computed - a
 * tenant-level trend per period, not an org-unit breakdown (`adherence_score`
 * carries no `org_unit_id`). Written by `MvAdherenceTrendRollupRefreshJobService`
 * via `MIGRATOR_PG_POOL` raw SQL, not this entity's own repository (the
 * refresh job writes cross-tenant in one tick, which needs the RLS-owner
 * bypass only `agno_migrator` has) - this class exists for Phase 4's
 * `agno_analytics_app`-scoped, single-tenant query-engine reads.
 */
@Entity({ name: 'mv_adherence_trend_rollup', schema: 'analytics_mv' })
export class MvAdherenceTrendRollup {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('varchar', { name: 'period_type' })
  periodType!: MvAdherenceTrendRollupPeriodType;

  @Column('timestamptz', { name: 'period_start' })
  periodStart!: Date;

  @Column('timestamptz', { name: 'period_end' })
  periodEnd!: Date;

  @Column('numeric', { name: 'avg_adherence_pct' })
  avgAdherencePct!: string;

  @Column('integer', { name: 'total_major_deviation_count' })
  totalMajorDeviationCount!: number;

  @Column('integer', { name: 'employee_count' })
  employeeCount!: number;

  @Column('timestamptz', { name: 'computed_at' })
  computedAt!: Date;
}
