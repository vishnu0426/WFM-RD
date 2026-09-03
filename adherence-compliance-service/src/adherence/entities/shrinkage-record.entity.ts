import { Column, Entity, PrimaryColumn } from 'typeorm';

export enum ShrinkageCategory {
  LEAVE = 'leave',
  TRAINING = 'training',
  MEETING = 'meeting',
  BREAK_OVERAGE = 'break_overage',
  ABSENCE = 'absence',
  OTHER = 'other',
}

/** §2.1: one row per org-unit/interval/category, same rollup-job-populated posture as `OccupancyRecord`. */
@Entity({ name: 'shrinkage_record', schema: 'compliance' })
export class ShrinkageRecord {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'org_unit_id' })
  orgUnitId!: string;

  @Column('timestamptz', { name: 'interval_start' })
  intervalStart!: Date;

  @Column('varchar', { name: 'shrinkage_category' })
  shrinkageCategory!: ShrinkageCategory;

  @Column('numeric', { name: 'shrinkage_pct', precision: 5, scale: 2 })
  shrinkagePct!: string;
}
