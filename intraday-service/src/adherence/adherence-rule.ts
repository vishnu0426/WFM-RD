import { ON_SHIFT_ACTIVITY } from '../schedule/scheduled-activity.service';

/**
 * ADR-0067: the only adherence signal derivable anywhere in this platform
 * today is coarse - `scheduled_activity` is `"on_shift"`/`null` (Phase 2,
 * ADR-0064's consequences: `ShiftAssignment` has no activity-code field).
 * Adherent means "scheduled to be on shift" - any `current_activity` value
 * is consistent with that, since there's no taxonomy to be stricter with.
 * `null`/anything else means non-adherent.
 */
export function isAdherent(scheduledActivity: string | null): boolean {
  return scheduledActivity === ON_SHIFT_ACTIVITY;
}

export interface PreviousAdherenceEvent {
  scheduledActivity: string | null;
  timestamp: Date;
}

/**
 * ADR-0067: `deviation_seconds` for a new row is the duration of the
 * segment that just ended (`from_activity`, spanning `previousEvent.timestamp`
 * to `thisEventTimestamp`) - 0 if that segment was adherent, otherwise its
 * length. `previousEvent === null` (this employee's very first-ever event)
 * also yields 0 - there is no prior segment to have been in deviation for,
 * the same "benefit of the doubt for genuinely unknown" outcome a separate
 * unknown-schedule flag would have given, without needing one.
 *
 * Deterministic - built entirely from stored timestamps, never
 * "processing time now" - so reprocessing the same message (a NATS
 * redelivery after a nak) produces the same value, not a different one
 * each time.
 */
export function computeDeviationSeconds(
  previousEvent: PreviousAdherenceEvent | null,
  thisEventTimestamp: Date,
): number {
  if (previousEvent === null || isAdherent(previousEvent.scheduledActivity)) {
    return 0;
  }
  const seconds = Math.floor((thisEventTimestamp.getTime() - previousEvent.timestamp.getTime()) / 1000);
  return Math.max(0, seconds);
}
