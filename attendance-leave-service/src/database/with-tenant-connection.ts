import { DataSource, EntityManager } from 'typeorm';

/**
 * Own copy of intraday-service's `with-tenant-connection.ts` (itself a copy
 * of the root app's `src/common/tenant/with-tenant-transaction.ts`,
 * ADR-0002's `set_config` idiom - `SET LOCAL app.current_tenant_id = $1`
 * isn't valid Postgres bind-parameter syntax), simplified the same way:
 * no `isPlatformAdmin` escape hatch, since nothing in this service has a
 * platform-admin concept.
 *
 * Every query against any `attendance_leave.*` table must go through this -
 * without it, RLS fails *closed* (an unset GUC means `tenant_id =
 * NULL::uuid`, never true) for a `SELECT`/`UPDATE`, and rejects the write
 * outright for an `INSERT` (`WITH CHECK` has nothing to match). Caught by
 * this phase's own real-Postgres verification, not by unit tests against
 * mocked repositories - see the Phase 2 design doc.
 */
export async function withTenantConnection<T>(
  dataSource: DataSource,
  tenantId: string,
  work: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  return dataSource.transaction(async (manager) => {
    await manager.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', tenantId]);
    return work(manager);
  });
}
