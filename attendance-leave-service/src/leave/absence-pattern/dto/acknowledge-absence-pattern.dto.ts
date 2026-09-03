import { IsIn, IsUUID } from 'class-validator';

/**
 * `acknowledgeAbsencePattern` (§2.2 rule 4, §3.1). `acknowledgedBy` is
 * client-supplied and trusted as-is - the same posture `decidedBy` has had
 * since Phase 4 (no JWT/session verification exists anywhere in this
 * service).
 *
 * `outcome` (Attendance & Leave Manager Views phase, §4): both of the
 * page's two allowed actions - "Acknowledge" and "Dismiss as not relevant" -
 * call this same endpoint, differing only in this field. Required, not
 * optional: an undifferentiated `acknowledge` would silently discard which
 * judgment the manager actually made.
 */
export class AcknowledgeAbsencePatternDto {
  @IsUUID()
  acknowledgedBy!: string;

  @IsIn(['acknowledged', 'dismissed'])
  outcome!: 'acknowledged' | 'dismissed';
}
