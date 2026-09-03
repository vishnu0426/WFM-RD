import { Pool, PoolClient } from 'pg';

/**
 * Sibling of `with-tenant-scoped-client.ts`'s `withTenantScopedClient`, for
 * the Tenant Monitoring dashboard's genuinely cross-tenant reads. Sets
 * `app.is_platform_monitoring` instead of `app.current_tenant_id` - the
 * second clause `1700010000000-TenantMonitoringRollupTables.ts`'s RLS
 * policy OR's in, on exactly the two tables that clause was added to
 * (`mv_tenant_onboarding_milestones`/`mv_tenant_health`). Every other
 * `analytics_mv.*` table has no such clause, so a query issued through this
 * helper against any other table still sees nothing (`app.current_tenant_id`
 * stays unset, and RLS fails closed) - this is deliberately not a general
 * "become platform admin" escape hatch, only these two tables opted in.
 *
 * Callers must still be gated by `PlatformAdminGuard` at the HTTP layer -
 * this helper only controls what the *database* returns, not who may call
 * the endpoint that uses it.
 */
export async function withPlatformMonitoringScopedClient<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.is_platform_monitoring', 'true']);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
