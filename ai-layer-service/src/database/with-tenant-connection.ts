import { DataSource, EntityManager } from 'typeorm';

/**
 * Own copy of every other service's `with-tenant-connection.ts` (ADR-0002's
 * `set_config` idiom - `SET LOCAL app.current_tenant_id = $1` isn't valid
 * Postgres bind-parameter syntax). Every query against any `ai_layer.*`
 * table must go through this - without it, RLS fails *closed* for a
 * `SELECT`/`UPDATE` (an unset GUC means `tenant_id = NULL::uuid`, never
 * true) and rejects the write outright for an `INSERT`.
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
