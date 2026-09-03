import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Phase 2 (ADR-0108): re-aggregates Module 03's `ForecastAccuracyLog` into
 * daily `(tenantId, orgUnitId)` buckets - `ForecastAccuracyLog` has no
 * pre-existing period bucketing of its own. `periodStart`/`periodEnd` are
 * UTC calendar-day boundaries (`migrator-replica-pool.provider.ts`'s own
 * doc comment explains why UTC, not a per-tenant timezone, is the honest
 * grain here). Written by `MvForecastAccuracyTrendRefreshJobService` via
 * `MIGRATOR_PG_POOL` raw SQL, not this entity's own repository - this
 * class exists for Phase 4's `agno_analytics_app`-scoped query-engine reads.
 */
@Entity({ name: 'mv_forecast_accuracy_trend', schema: 'analytics_mv' })
export class MvForecastAccuracyTrend {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'org_unit_id' })
  orgUnitId!: string;

  @Column('timestamptz', { name: 'period_start' })
  periodStart!: Date;

  @Column('timestamptz', { name: 'period_end' })
  periodEnd!: Date;

  @Column('numeric', { name: 'avg_mape', nullable: true })
  avgMape!: string | null;

  @Column('numeric', { name: 'avg_bias', nullable: true })
  avgBias!: string | null;

  @Column('integer', { name: 'forecast_count' })
  forecastCount!: number;

  @Column('timestamptz', { name: 'computed_at' })
  computedAt!: Date;
}
