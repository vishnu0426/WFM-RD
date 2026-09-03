import { AttendanceRecordDto } from '@/api/types';

export interface HoursWorkedSummary {
  totalHours: number;
  closedRecordCount: number;
  /** The currently-open record (`clockOutAt: null`), if any — excluded
   * from `totalHours` entirely (docs/adr/0156): a static total that
   * silently included an ever-growing open segment would misrepresent
   * its own precision on a read-only, non-live screen. */
  openRecord: AttendanceRecordDto | null;
}

/** Pure client-side summation — attendance-leave-service's own endpoint
 * deliberately returns raw records, not a pre-summed total
 * (docs/adr/0156). */
export function computeHoursWorked(records: AttendanceRecordDto[]): HoursWorkedSummary {
  let totalHours = 0;
  let closedRecordCount = 0;
  let openRecord: AttendanceRecordDto | null = null;

  for (const record of records) {
    if (!record.clockOutAt) {
      // Records are typically singular per employee at a time, but be
      // defensive - keep the most recent open record if more than one
      // somehow appears.
      if (!openRecord || new Date(record.clockInAt) > new Date(openRecord.clockInAt)) {
        openRecord = record;
      }
      continue;
    }
    const hours = (new Date(record.clockOutAt).getTime() - new Date(record.clockInAt).getTime()) / (60 * 60 * 1000);
    totalHours += hours;
    closedRecordCount += 1;
  }

  return { totalHours, closedRecordCount, openRecord };
}
