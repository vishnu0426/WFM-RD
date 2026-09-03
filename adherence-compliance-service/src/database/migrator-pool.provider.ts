import { Provider } from '@nestjs/common';
import { Pool } from 'pg';

export const MIGRATOR_PG_POOL = Symbol('MIGRATOR_PG_POOL');

/**
 * Own copy of intraday-service's/attendance-leave-service's
 * `migrator-pool.provider.ts` (ADR-0039 precedent: each service owns its
 * cross-service/cross-tenant infrastructure rather than sharing one).
 * Phase 3's two callers: `AdherenceDailyRollupJobService`/
 * `AdherenceWeeklyMonthlyRollupJobService`. A legitimate exception to "the
 * running app only ever holds the least-privilege runtime role" (every
 * other query in this service uses `agno_compliance_app`, via
 * `typeorm.config.ts`), for two independent reasons (ADR-0098):
 *
 * - The daily rollup reads `intraday.adherence_event` cross-tenant in one
 *   tick - RLS's `ENABLE` (not `FORCE`) posture means only the table
 *   *owner* (`agno_migrator`) bypasses per-tenant scoping; neither
 *   `agno_compliance_app` (no grant on `intraday.*` at all, ADR-0093) nor
 *   `agno_intraday_app` (a normal runtime role, not the owner) would see
 *   more than a single tenant's rows per connection.
 * - Both jobs write `compliance.adherence_score` cross-tenant in one tick
 *   too, for the identical reason.
 *
 * Phase 7's `RetentionLifecycleJobService` (docs/adr/0106) is this
 * provider's third caller and second *registration* - `ComplianceModule`
 * provides its own copy (a second `pg.Pool`, not a shared one) rather than
 * importing `AdherenceModule` for it, since the two feature areas are
 * otherwise unrelated and module-boundary separation was judged worth a
 * second small connection pool (max 2 connections each) over that
 * coupling. The retention job needs `agno_migrator` for the identical
 * `ENABLE`-not-`FORCE` RLS reason as the rollup jobs: it deletes
 * `compliance.compliance_report` rows cross-tenant in one sweep.
 *
 * Internal maintenance jobs only, not user-facing data access - never add
 * a fourth caller (of either registration) without updating this doc
 * comment and the security review that goes with it.
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
