import { Pool, PoolClient } from 'pg';

/**
 * Raw-`pg` equivalent of `with-tenant-connection.ts`'s `withTenantConnection`,
 * for `ANALYTICS_APP_REPLICA_PG_POOL` - `MetricQueryEngineService`'s reads
 * against `analytics_mv.mv_*` run as raw parameterized SQL (no TypeORM
 * entity manager involved on this connection), but need the identical
 * `set_config('app.current_tenant_id', ...)`-inside-a-transaction discipline
 * for RLS to scope correctly. A single `pool.query()` call risks landing on
 * a different physical connection than a prior `set_config` call - this
 * function pins one `PoolClient` for both.
 */
export async function withTenantScopedClient<T>(
  pool: Pool,
  tenantId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', tenantId]);
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
