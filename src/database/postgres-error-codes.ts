// https://www.postgresql.org/docs/current/errcodes-appendix.html
// Own copy, same convention every other service in this platform already
// uses (e.g. mobile-ess-service/src/database/postgres-error-codes.ts) -
// no shared library exists for this across services.
const UNIQUE_VIOLATION = '23505';

function sqlStateOf(err: unknown): string | undefined {
  return (
    (err as { code?: string; driverError?: { code?: string } })?.code ??
    (err as { driverError?: { code?: string } })?.driverError?.code
  );
}

export function isUniqueViolation(err: unknown): boolean {
  return sqlStateOf(err) === UNIQUE_VIOLATION;
}

/** The violated index/constraint's name (e.g. `uq_employees_tenant_id_user_id`) — lets a caller distinguish which of several unique constraints on one table actually fired, since Postgres reports the same SQLSTATE for all of them. */
export function constraintNameOf(err: unknown): string | undefined {
  return (
    (err as { constraint?: string; driverError?: { constraint?: string } })?.constraint ??
    (err as { driverError?: { constraint?: string } })?.driverError?.constraint
  );
}
