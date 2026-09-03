import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * §2.1/§3.4, ADR-0066: append-only compliance record, `PARTITION BY RANGE
 * (timestamp)` daily (the migration's DDL, not TypeORM `synchronize` -
 * ORM defines shape, migration SQL is the real DDL, per ADR-0016). This
 * class exists for query-building (`AdherenceCalculatorConsumerService`'s
 * "most recent event for this employee" lookup and inserts) - it does not
 * and cannot express `PARTITION BY`/RLS/BRIN in TypeORM decorators.
 *
 * Composite PK `(id, timestamp)`: Postgres requires the partition key in
 * every unique index, same shape as `core.audit_log`/
 * `forecasting.forecast_data_points`.
 */
@Entity({ name: 'adherence_event', schema: 'intraday' })
export class AdherenceEvent {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'employee_id' })
  employeeId!: string;

  /** Always `'activity_changed'` this phase - the column exists for future producers (ADR-0067 assumption 1). */
  @Column('varchar', { name: 'event_type' })
  eventType!: string;

  @Column('varchar', { name: 'from_activity', nullable: true })
  fromActivity!: string | null;

  @Column('varchar', { name: 'to_activity' })
  toActivity!: string;

  @Column('varchar', { name: 'scheduled_activity', nullable: true })
  scheduledActivity!: string | null;

  @Column('integer', { name: 'deviation_seconds' })
  deviationSeconds!: number;

  @PrimaryColumn('timestamptz')
  timestamp!: Date;
}
