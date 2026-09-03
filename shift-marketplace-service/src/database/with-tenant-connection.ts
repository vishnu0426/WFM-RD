import { DataSource, EntityManager } from 'typeorm';

/**
 * Own copy of every other TypeORM-based service's
 * `with-tenant-connection.ts` (ultimately ADR-0002's `set_config` idiom -
 * `SET LOCAL app.current_tenant_id = $1` isn't valid Postgres
 * bind-parameter syntax). No `isPlatformAdmin` escape hatch, same
 * simplification attendance-leave-service's own copy makes - nothing in
 * this service has a platform-admin concept.
 *
 * Every query against any `marketplace.*` table must go through this -
 * without it, RLS fails *closed* (an unset GUC means `tenant_id =
 * NULL::uuid`, never true) for a `SELECT`/`UPDATE`, and rejects the write
 * outright for an `INSERT` (`WITH CHECK` has nothing to match).
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
