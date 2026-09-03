import { Provider } from '@nestjs/common';
import { Pool } from 'pg';

export const MIGRATOR_PG_POOL = Symbol('MIGRATOR_PG_POOL');

/**
 * ADR-0066: a narrowly-scoped, `agno_migrator`-credentialed connection
 * pool, used by exactly two call sites -
 * `AdherencePartitionSchedulerService` and `AdherenceRollupSchedulerService`
 * - and nowhere else in this service. Both are legitimate exceptions to
 * "the running app only ever holds the least-privilege runtime role"
 * (every other query in this service uses `agno_intraday_app`, via
 * `typeorm.config.ts`):
 *
 * - Partition creation/retention is DDL, and `agno_intraday_app`
 *   deliberately has no `CREATE` grant on the `intraday` schema (the
 *   migration's own doc comment) - only the schema owner can run it.
 * - Rollup aggregation is cross-tenant by nature (one tick aggregates
 *   every tenant's events in the trailing window) - RLS's `ENABLE` (not
 *   `FORCE`) posture (ADR-0002) means only the table *owner* bypasses
 *   per-tenant scoping; `agno_intraday_app` would see zero rows outside
 *   whatever single `app.current_tenant_id` happened to be set, if any.
 *
 * These are internal maintenance jobs, not user-facing data access - never
 * add a third caller of this pool without updating this doc comment and
 * the security review that goes with it.
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
