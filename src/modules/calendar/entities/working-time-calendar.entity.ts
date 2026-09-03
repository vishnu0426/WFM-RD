import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * `org_unit_id IS NULL` means the tenant-wide default calendar - enforced as
 * at most one per tenant via a partial unique index in the Phase 1
 * migration, mirroring `Policy`'s "one open version" partial index
 * (ADR-0006).
 */
@Entity({ schema: 'org', name: 'working_time_calendars' })
@Index('idx_working_time_calendars_tenant_id_org_unit_id', ['tenantId', 'orgUnitId'])
export class WorkingTimeCalendar {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'org_unit_id', nullable: true })
  orgUnitId!: string | null;

  @Column({ type: 'varchar', length: 2, name: 'country_code' })
  countryCode!: string;

  /**
   * Added in the Phase 4 migration (§5's decay-job scheduling needs it -
   * §2.1's original field list didn't name it, see that migration's own
   * comment). An IANA zone name (e.g. `America/New_York`); not validated at
   * the DB level, only by `SkillDecaySchedulerService` falling back to UTC
   * if `Intl.DateTimeFormat` rejects it.
   */
  @Column({ type: 'varchar', length: 50, default: 'UTC' })
  timezone!: string;

  @Column({ type: 'jsonb', name: 'holiday_dates' })
  holidayDates!: string[];

  @Column({ type: 'jsonb', name: 'standard_business_hours' })
  standardBusinessHours!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
