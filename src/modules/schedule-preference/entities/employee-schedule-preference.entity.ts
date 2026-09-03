import { Entity, PrimaryColumn, Column, UpdateDateColumn } from 'typeorm';
import { Weekday } from './weekday.enum';
import { SchedulePreferenceSlot } from './schedule-preference-slot.interface';

/** One row per employee (composite PK, no surrogate `id`) - upsert-only, same "settings object" shape as a user profile rather than a versioned list. */
@Entity({ schema: 'org', name: 'employee_schedule_preferences' })
export class EmployeeSchedulePreference {
  @PrimaryColumn({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @PrimaryColumn({ type: 'uuid', name: 'employee_id' })
  employeeId!: string;

  @Column({ type: 'time', name: 'preferred_shift_start', nullable: true })
  preferredShiftStart!: string | null;

  @Column({ type: 'time', name: 'preferred_shift_end', nullable: true })
  preferredShiftEnd!: string | null;

  /** Array order *is* the day-off priority (highest priority first) — Postgres `text[]` preserves insertion order round-trip, so no separate priority column is needed; callers must resend the full array in their intended order on every upsert. */
  @Column({ type: 'text', array: true, name: 'preferred_days_off', nullable: true })
  preferredDaysOff!: Weekday[] | null;

  /**
   * Closes the reference's "First / Second / Third Preference" + "Early /
   * Late" fields, which `preferredShiftStart`/`preferredShiftEnd` above
   * never modeled (a single window, not ranked ones). At most 3 entries,
   * one per `rank` — see `SchedulePreferenceSlot`'s own doc comment for why
   * jsonb rather than a child table.
   */
  @Column({ type: 'jsonb', name: 'preference_slots', nullable: true })
  preferenceSlots!: SchedulePreferenceSlot[] | null;

  @Column({ type: 'numeric', precision: 5, scale: 2, name: 'max_weekly_hours', nullable: true })
  maxWeeklyHours!: string | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @Column({ type: 'uuid', name: 'updated_by', nullable: true })
  updatedBy!: string | null;
}
