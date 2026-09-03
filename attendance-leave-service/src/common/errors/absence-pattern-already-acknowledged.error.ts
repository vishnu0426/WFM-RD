import { DomainError } from './domain-error';

/** §2.2 rule 4: an `AbsencePattern` is acknowledged at most once - mirrors `LeaveRequestAlreadyDecidedError`'s "not idempotent by design" posture (there is no client-supplied idempotency key for an acknowledgement, and re-acknowledging would silently overwrite who actually reviewed it). */
export class AbsencePatternAlreadyAcknowledgedError extends DomainError {
  constructor(id: string, acknowledgedBy: string) {
    super(
      'ABSENCE_PATTERN_ALREADY_ACKNOWLEDGED',
      `AbsencePattern ${id} was already acknowledged by ${acknowledgedBy}.`,
    );
  }
}
