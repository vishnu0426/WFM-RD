import { Provider } from '@nestjs/common';
import { Pool } from 'pg';

export const MIGRATOR_PG_POOL = Symbol('MIGRATOR_PG_POOL');

/**
 * Own copy of attendance-leave-service's/intraday-service's
 * `migrator-pool.provider.ts` (ADR-0039 precedent). Phase 4's sole caller:
 * `BidCloseSweepService`. A legitimate exception to "the running app only
 * ever holds the least-privilege runtime role" (every other query in this
 * service uses `agno_marketplace_app`, via `typeorm.config.ts`): the close
 * sweep must find expired-but-unclosed bid opportunities across *every*
 * tenant in one tick, and this service's RLS posture is `ENABLE`, not
 * `FORCE` (`InitialMarketplaceSchema`'s own migration) - only the table
 * *owner* (`agno_migrator`) bypasses per-tenant scoping;
 * `agno_marketplace_app` would see zero rows outside whatever single
 * `app.current_tenant_id` happened to be bound, if any.
 *
 * Internal maintenance job only, not user-facing data access - never add a
 * second caller of this pool without updating this doc comment and the
 * security review that goes with it.
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
