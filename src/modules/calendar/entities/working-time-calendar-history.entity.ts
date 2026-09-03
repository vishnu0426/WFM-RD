import { Entity, PrimaryColumn, Column, Index } from 'typeorm';

/**
 * GAP-07 fix (enterprise readiness audit, 2026-08-18). ADR-0009 (SCD Type
 * 2), unpartitioned - same shape as `OrgUnitHistory`, matching
 * `WorkingTimeCalendar`'s own unpartitioned live table. Written by
 * `org.fn_working_time_calendar_history_track` (`1700000018000`) on every
 * INSERT and on any UPDATE that changes `country_code`, `timezone`,
 * `holiday_dates`, or `standard_business_hours` - never by application
 * code (same append-only posture as `EmployeeHistory`/`OrgUnitHistory`).
 */
@Entity({ schema: 'org', name: 'working_time_calendar_history' })
@Index('idx_working_time_calendar_history_tenant_calendar', ['tenantId', 'calendarId', 'validFrom'])
export class WorkingTimeCalendarHistory {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'calendar_id' })
  calendarId!: string;

  @Column({ type: 'timestamptz', name: 'valid_from' })
  validFrom!: Date;

  /** NULL = this is the currently active version. */
  @Column({ type: 'timestamptz', name: 'valid_to', nullable: true })
  validTo!: Date | null;

  @Column({ type: 'uuid', name: 'org_unit_id', nullable: true })
  orgUnitId!: string | null;

  @Column({ type: 'varchar', length: 2, name: 'country_code' })
  countryCode!: string;

  @Column({ type: 'varchar', length: 50 })
  timezone!: string;

  @Column({ type: 'jsonb', name: 'holiday_dates' })
  holidayDates!: string[];

  @Column({ type: 'jsonb', name: 'standard_business_hours' })
  standardBusinessHours!: Record<string, unknown>;
}
