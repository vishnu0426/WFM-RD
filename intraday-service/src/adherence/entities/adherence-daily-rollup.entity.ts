import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Same shape as `AdherenceHourlyRollup`, `bucket_start` truncated to the
 * day - see that entity's doc comment, including the GAP-11 warning about
 * `nonAdherentEvents`/`totalEvents` being event counts, not the same
 * measure as adherence-compliance-service's duration-weighted `AdherenceScore.adherencePct`.
 */
@Entity({ name: 'adherence_daily_rollup', schema: 'intraday' })
export class AdherenceDailyRollup {
  @PrimaryColumn('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @PrimaryColumn('uuid', { name: 'employee_id' })
  employeeId!: string;

  @PrimaryColumn('timestamptz', { name: 'bucket_start' })
  bucketStart!: Date;

  @Column('integer', { name: 'total_events' })
  totalEvents!: number;

  @Column('integer', { name: 'non_adherent_events' })
  nonAdherentEvents!: number;

  @Column('bigint', { name: 'total_deviation_seconds' })
  totalDeviationSeconds!: string;
}
