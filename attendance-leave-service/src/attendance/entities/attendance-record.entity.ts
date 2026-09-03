import { Column, Entity, PrimaryColumn } from 'typeorm';

export enum AttendanceSource {
  BADGE = 'badge',
  BIOMETRIC = 'biometric',
  MANUAL = 'manual',
  MOBILE_APP = 'mobile_app',
}

export enum AttendanceExceptionType {
  LATE = 'late',
  EARLY_LEAVE = 'early_leave',
  NO_SHOW = 'no_show',
  UNSCHEDULED_WORK = 'unscheduled_work',
  /** Module 11 Phase 6 (docs/adr/0155): set when mobile-ess-service's own
   * geofence check (`geofenceVerified === false` on the incoming
   * `ClockEventDto`) finds the clock event outside the employee's org
   * unit's configured boundary, under soft enforcement. Inherits this
   * column's own already-disclosed single-value limitation verbatim - see
   * `AttendanceExceptionDetectionService`'s doc comment. */
  GEOFENCE_VIOLATION = 'geofence_violation',
}

/**
 * §2.1/§2.2 rule 3: `scheduledShiftId` links directly to Module 04's actual
 * `ShiftAssignment` row - a plain cross-schema uuid, never a SQL `REFERENCES`
 * (ADR-0052 discipline, restated in ADR-0073 for this schema) - not a
 * generic scheduled/unscheduled boolean, since Module 08's adherence
 * scoring depends on this being the real linkage. `exceptionType`/
 * `exceptionMinutes` are populated by exception-detection logic that
 * compares this record against that shift assignment - real in Phase 2,
 * not this phase (schema/migrations only).
 */
@Entity({ name: 'attendance_record', schema: 'attendance_leave' })
export class AttendanceRecord {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'employee_id' })
  employeeId!: string;

  @Column('timestamptz', { name: 'clock_in_at' })
  clockInAt!: Date;

  @Column('timestamptz', { name: 'clock_out_at', nullable: true })
  clockOutAt!: Date | null;

  @Column('varchar', { name: 'source' })
  source!: AttendanceSource;

  @Column('uuid', { name: 'scheduled_shift_id', nullable: true })
  scheduledShiftId!: string | null;

  @Column('varchar', { name: 'exception_type', nullable: true })
  exceptionType!: AttendanceExceptionType | null;

  @Column('integer', { name: 'exception_minutes', nullable: true })
  exceptionMinutes!: number | null;

  /** Module 11 Phase 6 (docs/adr/0155) - mobile-ess-service's own already-
   * computed geofence verification outcome, recorded as-is here, never
   * recomputed by this service. `null` when geofencing isn't enabled for
   * the employee's org unit. */
  @Column('boolean', { name: 'geofence_verified', nullable: true })
  geofenceVerified!: boolean | null;
}
