import { DataSource, EntityManager } from 'typeorm';

/**
 * GAP-16 fix (enterprise readiness audit, 2026-08-18): this service's
 * `mobile_ess.*` tables have carried a real RLS policy
 * (`tenant_id = current_setting('app.current_tenant_id', true)::uuid`)
 * since their very first migration, but `DevicesService`/`MobileSyncService`
 * used a plain `@InjectRepository`-bound `Repository` and never once called
 * `set_config` - meaning every read silently returned zero rows and every
 * write was rejected outright by the `WITH CHECK` clause the instant RLS
 * was actually enforced (confirmed via a real Postgres session: a bare
 * `INSERT` as `agno_mobile_ess_app` fails with "new row violates row-level
 * security policy"). This service has never had a real integration test
 * proving its own RLS-enabled tables were reachable at all - the exact gap
 * GAP-16 was written to close.
 *
 * Own copy of every other service's `with-tenant-connection.ts` (ADR-0002's
 * `set_config` idiom - `SET LOCAL app.current_tenant_id = $1` isn't valid
 * Postgres bind-parameter syntax). No `isPlatformAdmin` escape hatch, since
 * nothing in this service has a platform-admin concept.
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
