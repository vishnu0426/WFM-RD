import { DataSource, EntityManager } from 'typeorm';

export interface TenantTransactionContext {
  tenantId: string;
  /** ADR-0007: additive cross-tenant escape hatch, only meaningful today for `core.tenants`. */
  isPlatformAdmin?: boolean;
}

/**
 * Opens a transaction and binds both `app.current_tenant_id` and
 * `app.is_platform_admin` for its duration via `set_config(..., true)` (the
 * parameterized equivalent of `SET LOCAL`; a literal
 * `SET LOCAL app.current_tenant_id = $1` is not valid Postgres syntax - SET
 * does not accept bind parameters) so the RLS policies in the Phase 1
 * migration can enforce isolation as defense-in-depth under
 * TenantScopedRepository. Both values must already be validated/sourced
 * from TenantContextService - never from client-supplied input.
 */
export async function withTenantTransaction<T>(
  dataSource: DataSource,
  context: TenantTransactionContext,
  work: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  return dataSource.transaction(async (manager) => {
    await manager.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', context.tenantId]);
    await manager.query('SELECT set_config($1, $2, true)', [
      'app.is_platform_admin',
      context.isPlatformAdmin ? 'true' : 'false',
    ]);
    return work(manager);
  });
}
