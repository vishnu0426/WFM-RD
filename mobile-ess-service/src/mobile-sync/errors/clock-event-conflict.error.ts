/**
 * attendance-leave-service returned 409 - `NoOpenAttendanceRecordError`
 * (clock-out with no open clock-in) or `AttendanceRecordConflictError`
 * (concurrent-close race). A real conflict this phase can actually
 * produce, never auto-resolved (source spec's non-negotiable) - caught by
 * `mobile-sync.service.ts` and turned into `status: conflict` with
 * `conflictDetails` populated from the upstream error, surfaced to the
 * employee for explicit resolution.
 */
export class ClockEventConflictError extends Error {
  constructor(
    public readonly upstreamCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'ClockEventConflictError';
  }
}
