import { DataSource, EntityManager } from 'typeorm';

/**
 * Own copy of every other service's `with-tenant-connection.ts` (ADR-0002's
 * `set_config` idiom - `SET LOCAL app.current_tenant_id = $1` isn't valid
 * Postgres bind-parameter syntax; `set_config(..., true)` is the
 * parameterized equivalent, scoped to the current transaction). Deferred
 * out of Phase 1-3 (no request path existed yet to need it) - `DashboardService`
 * (Phase 4) is this file's first caller.
 *
 * Every query against `analytics.saved_report`/`metric_definition`/
 * `dashboard_widget` must go through this - without it, RLS fails *closed*
 * for a `SELECT`/`UPDATE` (an unset GUC means `tenant_id = NULL::uuid`,
 * never true) and rejects an `INSERT` outright. For `metric_definition`
 * specifically (the nullable-tenant-id platform-default shape), an unset
 * GUC would make even a platform-default row's `OR tenant_id IS NULL`
 * `USING` clause the only thing still readable - silently hiding every
 * tenant-scoped row, not failing loudly.
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
