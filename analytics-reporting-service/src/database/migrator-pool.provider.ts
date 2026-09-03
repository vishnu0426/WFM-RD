import { Provider } from '@nestjs/common';
import { Pool } from 'pg';

export const MIGRATOR_PG_POOL = Symbol('MIGRATOR_PG_POOL');

/**
 * Own copy of intraday-service's/attendance-leave-service's/adherence-
 * compliance-service's `migrator-pool.provider.ts` (ADR-0039 precedent:
 * each service owns its cross-service/cross-tenant infrastructure rather
 * than sharing one), pointed at the **primary** - `DB_HOST`/`DB_PORT`, the
 * same host `typeorm.config.ts` uses.
 *
 * Phase 2's refresh jobs (`MvAdherenceTrendRollupRefreshJobService`/
 * `MvForecastAccuracyTrendRefreshJobService`) are this provider's callers,
 * for exactly the reason ADR-0098 documents for Module 08's identical
 * provider: both jobs write `analytics_mv.mv_*` cross-tenant in one tick,
 * and RLS's `ENABLE` (not `FORCE`) posture means only the table *owner*
 * (`agno_migrator`) bypasses per-tenant scoping - `agno_analytics_app` (a
 * normal runtime role, not the owner) would see only a single tenant's
 * rows per connection, and the whole point of this job is to touch every
 * tenant's rows in one pass. See `migrator-replica-pool.provider.ts` for
 * this same job's *source* reads - a different pool, a different host.
 *
 * Internal maintenance jobs only, not user-facing data access - never add
 * a caller that serves a live user-facing request without updating this
 * doc comment and the security review that goes with it.
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
