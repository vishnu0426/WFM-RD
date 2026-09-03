import { EarlyLate } from './early-late.enum';

/**
 * One ranked entry of the "First / Second / Third Preference" reference
 * field — stored as a jsonb array on `EmployeeSchedulePreference.preferenceSlots`
 * rather than a child table: at most 3 rows, always read/written as a whole
 * unit with the parent (same "one row per employee, upsert-only settings
 * object" shape the entity's own doc comment already establishes for
 * `preferredDaysOff`), so a separate table would only add a join for no
 * transactional or query benefit.
 */
export interface SchedulePreferenceSlot {
  rank: 1 | 2 | 3;
  startTime: string | null;
  endTime: string | null;
  earlyLate: EarlyLate | null;
}
