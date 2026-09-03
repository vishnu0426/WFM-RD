// https://www.postgresql.org/docs/current/errcodes-appendix.html
const UNIQUE_VIOLATION = '23505';
/** GAP-09 fix (enterprise readiness audit, 2026-08-18): raised by `leave_request_no_overlapping_active_ranges` (an EXCLUDE constraint, not a UNIQUE one - a different SQLSTATE). */
const EXCLUSION_VIOLATION = '23P01';

function sqlStateOf(err: unknown): string | undefined {
  return (
    (err as { code?: string; driverError?: { code?: string } })?.code ??
    (err as { driverError?: { code?: string } })?.driverError?.code
  );
}

export function isUniqueViolation(err: unknown): boolean {
  return sqlStateOf(err) === UNIQUE_VIOLATION;
}

export function isExclusionViolation(err: unknown): boolean {
  return sqlStateOf(err) === EXCLUSION_VIOLATION;
}
