import { DataSource, EntityManager } from 'typeorm';

/**
 * Own copy of every other service's `with-tenant-connection.ts` (ADR-0002's
 * `set_config` idiom - `SET LOCAL app.current_tenant_id = $1` isn't valid
 * Postgres bind-parameter syntax). Deferred out of Phase 1 (no request path
 * existed yet to need it) - this is Phase 2's first caller
 * (`ComplianceRuleService`).
 *
 * Every query against any `compliance.*` table must go through this -
 * without it, RLS fails *closed* (an unset GUC means `tenant_id =
 * NULL::uuid`, never true, for the uniformly-tenant-scoped tables) for a
 * `SELECT`/`UPDATE`, and rejects the write outright for an `INSERT` (`WITH
 * CHECK` has nothing to match). For `compliance_rule`/`retention_policy`
 * specifically (ADR-0095's split policy), an unset GUC would make even a
 * platform-default row's `OR tenant_id IS NULL` `USING` clause the *only*
 * thing still readable - silently hiding every tenant-scoped row from a
 * query that forgot to bind context, not failing loudly. Caught by this
 * phase's own real-Postgres verification, not by unit tests against mocked
 * repositories.
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
