import { Provider } from '@nestjs/common';
import { Pool } from 'pg';

export const MIGRATOR_PG_POOL = Symbol('MIGRATOR_PG_POOL');

/**
 * Own copy of every other service's `migrator-pool.provider.ts` (ADR-0039
 * precedent). `BatchSyncRunnerService.tick()` is this module's sole
 * caller: finding which batch connectors are due is cross-tenant by nature
 * (one tick scans every tenant's active connectors), and this service's
 * RLS posture is `ENABLE`, not `FORCE` (`InitialIntegrationHubSchema`'s
 * own migration) - only the table *owner* (`agno_migrator`) bypasses
 * per-tenant scoping; `agno_integration_hub_app` would see zero rows
 * outside whatever single `app.current_tenant_id` happened to be bound.
 *
 * Read-only use only: the tick's own per-connector `SyncJob` writes go
 * through the normal tenant-scoped `withTenantConnection` path, using each
 * connector's own `tenant_id` from the row itself - this pool never writes.
 * Internal maintenance job only, not user-facing data access - never add a
 * second caller of this pool without updating this doc comment and the
 * security review that goes with it, especially given this module's own
 * larger-than-usual attack-surface framing (§0).
 */
export const migratorPoolProvider: Provider = {
  provide: MIGRATOR_PG_POOL,
  useFactory: (): Pool =>
    new Pool({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_MIGRATION_USERNAME ?? 'agno_migrator',
      password: process.env.DB_MIGRATION_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
      max: 2,
    }),
};
