import { Column, Entity, PrimaryColumn } from 'typeorm';

/** §6.1, ADR-0071 - the queue-side equivalent of `AdherenceEvent`'s role for `AgentLiveState`: a Postgres degraded-fallback source for `QueueLiveStateQueryService`. Append-only, not partitioned - see the migration's own doc comment. */
@Entity({ name: 'queue_metrics_snapshot', schema: 'intraday' })
export class QueueMetricsSnapshot {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'queue_id' })
  queueId!: string;

  @Column('integer', { name: 'current_volume' })
  currentVolume!: number;

  @Column('integer', { name: 'agents_available' })
  agentsAvailable!: number;

  @Column('integer', { name: 'agents_on_call' })
  agentsOnCall!: number;

  @Column('integer', { name: 'forecasted_volume', nullable: true })
  forecastedVolume!: number | null;

  /** `numeric` comes back from `pg` as a string unless transformed - node-pg's own well-known behavior, not a TypeORM quirk specific to this column. */
  @Column('numeric', {
    name: 'service_level_current',
    nullable: true,
    transformer: { to: (v: number | null) => v, from: (v: string | null) => (v === null ? null : Number(v)) },
  })
  serviceLevelCurrent!: number | null;

  @Column('numeric', {
    name: 'service_level_target',
    nullable: true,
    transformer: { to: (v: number | null) => v, from: (v: string | null) => (v === null ? null : Number(v)) },
  })
  serviceLevelTarget!: number | null;

  @Column('timestamptz', { name: 'captured_at' })
  capturedAt!: Date;
}
