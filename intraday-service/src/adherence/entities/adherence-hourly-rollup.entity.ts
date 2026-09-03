import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * §3.4/ADR-0066: pre-aggregated so Module 09's trend queries hit this small
 * table instead of scanning raw `adherence_event` partitions. Maintained
 * by `AdherenceRollupSchedulerService`'s `@Cron` upsert, not a Postgres
 * materialized view or `pg_cron` job - neither has any precedent anywhere
 * in this platform (ADR-0066). Keyed by `(tenant_id, employee_id,
 * bucket_start)`, not `org_unit_id` - see that ADR's consequences section.
 *
 * GAP-11 (enterprise readiness audit, 2026-08-18): `nonAdherentEvents`/
 * `totalEvents` are event *counts*, not the same measure as
 * adherence-compliance-service's duration-weighted `AdherenceScore.adherencePct`
 * - see `AdherenceRollupSchedulerService`'s own doc comment before deriving
 * a percentage from this table.
 */
@Entity({ name: 'adherence_hourly_rollup', schema: 'intraday' })
export class AdherenceHourlyRollup {
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
