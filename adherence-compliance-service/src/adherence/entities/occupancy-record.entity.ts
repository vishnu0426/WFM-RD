import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * §2.1: `orgUnitId`-scoped 15-minute-interval occupancy rollup - a plain
 * cross-module uuid into Module 02's org-unit hierarchy, never a SQL
 * `REFERENCES` across schemas (ADR-0052/0073/0083 discipline, restated for
 * this schema in ADR-0093). Same "real but unread until the rollup job
 * exists" posture as `AdherenceScore` - Phase 3 populates this, not Phase 1.
 */
@Entity({ name: 'occupancy_record', schema: 'compliance' })
export class OccupancyRecord {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'org_unit_id' })
  orgUnitId!: string;

  @Column('timestamptz', { name: 'interval_start' })
  intervalStart!: Date;

  @Column('integer', { name: 'talk_time_seconds', default: 0 })
  talkTimeSeconds!: number;

  @Column('integer', { name: 'acw_seconds', default: 0 })
  acwSeconds!: number;

  @Column('integer', { name: 'available_seconds', default: 0 })
  availableSeconds!: number;

  @Column('numeric', { name: 'occupancy_pct', precision: 5, scale: 2 })
  occupancyPct!: string;
}
