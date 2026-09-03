import { Column, Entity, PrimaryColumn } from 'typeorm';

export enum AbsencePatternType {
  RECURRING_DAY_OF_WEEK = 'recurring_day_of_week',
  PRE_POST_HOLIDAY = 'pre_post_holiday',
  FREQUENCY_THRESHOLD = 'frequency_threshold',
}

/**
 * §2.2 rule 4: `acknowledgedBy` gates everything downstream of a detected
 * pattern - an unacknowledged row is inert data, never an actionable
 * signal (no automated disciplinary flag, no manager notification implying
 * wrongdoing). That enforcement is application-layer (Phase 8, when
 * detection logic exists) and has nothing to check yet in Phase 1 beyond
 * the column being nullable and defaulting to unacknowledged.
 */
@Entity({ name: 'absence_pattern', schema: 'attendance_leave' })
export class AbsencePattern {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'employee_id' })
  employeeId!: string;

  @Column('varchar', { name: 'pattern_type' })
  patternType!: AbsencePatternType;

  @Column('numeric', { name: 'confidence_score', precision: 3, scale: 2 })
  confidenceScore!: string;

  @Column('timestamptz', { name: 'detected_at' })
  detectedAt!: Date;

  @Column('uuid', { name: 'acknowledged_by', nullable: true })
  acknowledgedBy!: string | null;

  /**
   * Attendance & Leave Manager Views phase, §4: "Acknowledge" and "Dismiss
   * as not relevant" are two distinct manager judgments, not one
   * undifferentiated review action - losing which one a manager chose
   * would erase the one piece of human judgment this deliberately
   * restrained page collects. Null until acknowledged (mirrors
   * `acknowledgedBy`'s own nullability); never read by any automated
   * logic (§4/§0's non-negotiable: this remains inert data either way).
   */
  @Column('varchar', { name: 'outcome', nullable: true })
  outcome!: 'acknowledged' | 'dismissed' | null;
}
