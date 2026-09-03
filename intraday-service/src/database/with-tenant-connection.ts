import { DataSource, EntityManager } from 'typeorm';

/**
 * Own copy of the root app's `src/common/tenant/with-tenant-transaction.ts`
 * (ADR-0002's `set_config` idiom - a literal `SET LOCAL app.current_tenant_id
 * = $1` isn't valid Postgres bind-parameter syntax), simplified: no
 * `isPlatformAdmin` escape hatch, since nothing in this service has a
 * platform-admin concept. `tenantId` here always comes from an already-
 * validated source - the NATS payload's own `tenantId` field, itself
 * derived from the ingestion endpoint's HMAC-verified tenant path segment
 * (§4.2) - never client-supplied at the point this function is called.
 *
 * Every query against `intraday.adherence_event`/the rollup tables must go
 * through this - without it, RLS (ADR-0066) fails *closed* (an unset GUC
 * means `tenant_id = NULL::uuid`, never true), which would silently look
 * like "no rows found" rather than a loud connection/config error.
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
