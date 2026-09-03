import { IsBoolean, IsEnum, IsISO8601, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { AttendanceSource } from '../entities/attendance-record.entity';
import { AttendanceClockEventType } from '../entities/attendance-ingestion-event.entity';

/**
 * §3.2's `POST .../clock-events` body. One event per physical tap - a
 * `clock_in` creates a new `AttendanceRecord`, a `clock_out` closes the
 * employee's currently-open one (§2.1's single clock_in_at/clock_out_at
 * pair per record, not a separate row per direction).
 */
export class ClockEventDto {
  /** The badge/biometric device's own event id - what `AttendanceIngestionService` dedupes on (ADR-0075). */
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  sourceEventId!: string;

  @IsUUID()
  employeeId!: string;

  @IsEnum(AttendanceClockEventType)
  eventType!: AttendanceClockEventType;

  @IsISO8601()
  occurredAt!: string;

  @IsEnum(AttendanceSource)
  source!: AttendanceSource;

  /** Module 11 Phase 6 (docs/adr/0155): mobile-ess-service's own already-
   * computed geofence verification outcome - `null`/omitted when
   * geofencing isn't enabled for the employee's org unit. This service
   * never recomputes it, only records it. */
  @IsOptional()
  @IsBoolean()
  geofenceVerified?: boolean | null;
}
