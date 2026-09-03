import { Column, Entity, PrimaryColumn } from 'typeorm';

export enum AdherenceScorePeriodType {
  SHIFT = 'shift',
  DAY = 'day',
  WEEK = 'week',
  MONTH = 'month',
}

/**
 * §2.1, §2.2 rule 1 (the module's core reproducibility promise): `adherencePct`
 * is a stored, computed-once value written by the rollup job, never a
 * view/on-read computation - a live-recomputing view would break the
 * instant new events land after a report was first generated. `computedAt`
 * is deliberately distinct from `periodEnd` so a reproducibility test (§0.5)
 * can assert "same period, requested twice, identical numbers" without
 * conflating "when this covers" with "when this ran." Nothing in this phase
 * writes or reads this table yet (schema/migrations only, §7 Phase 1) - the
 * rollup job that populates it via the upsert key
 * (`tenant_id, employee_id, period_type, period_start`) is Phase 3.
 */
@Entity({ name: 'adherence_score', schema: 'compliance' })
export class AdherenceScore {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'employee_id' })
  employeeId!: string;

  @Column('varchar', { name: 'period_type' })
  periodType!: AdherenceScorePeriodType;

  @Column('timestamptz', { name: 'period_start' })
  periodStart!: Date;

  @Column('timestamptz', { name: 'period_end' })
  periodEnd!: Date;

  @Column('integer', { name: 'adherent_seconds' })
  adherentSeconds!: number;

  @Column('integer', { name: 'total_scheduled_seconds' })
  totalScheduledSeconds!: number;

  @Column('numeric', { name: 'adherence_pct', precision: 5, scale: 2 })
  adherencePct!: string;

  @Column('integer', { name: 'major_deviation_count', default: 0 })
  majorDeviationCount!: number;

  @Column('timestamptz', { name: 'computed_at' })
  computedAt!: Date;
}
