import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity({ schema: 'org', name: 'work_rules' })
export class WorkRule {
  @PrimaryColumn({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'integer', name: 'max_consecutive_days', nullable: true })
  maxConsecutiveDays!: number | null;

  @Column({ type: 'numeric', precision: 5, scale: 2, name: 'min_rest_hours', nullable: true })
  minRestHours!: string | null;

  @Column({ type: 'numeric', precision: 5, scale: 2, name: 'max_weekly_hours', nullable: true })
  maxWeeklyHours!: string | null;

  @Column({ type: 'boolean', name: 'ot_eligible', default: true })
  otEligible!: boolean;

  @Column({ type: 'numeric', precision: 6, scale: 2, name: 'min_paid_hours', nullable: true })
  minPaidHours!: string | null;

  @Column({ type: 'numeric', precision: 6, scale: 2, name: 'max_ot_per_day', nullable: true })
  maxOtPerDay!: string | null;

  @Column({ type: 'numeric', precision: 6, scale: 2, name: 'max_ot_per_week', nullable: true })
  maxOtPerWeek!: string | null;

  @Column({ type: 'numeric', precision: 6, scale: 2, name: 'max_vto_per_day', nullable: true })
  maxVtoPerDay!: string | null;

  @Column({ type: 'numeric', precision: 6, scale: 2, name: 'max_vto_per_week', nullable: true })
  maxVtoPerWeek!: string | null;

  @Column({ type: 'numeric', precision: 6, scale: 2, name: 'required_pay_period_hours', nullable: true })
  requiredPayPeriodHours!: string | null;

  @Column({ type: 'date', name: 'effective_from', nullable: true })
  effectiveFrom!: string | null;

  @Column({ type: 'date', name: 'effective_to', nullable: true })
  effectiveTo!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
