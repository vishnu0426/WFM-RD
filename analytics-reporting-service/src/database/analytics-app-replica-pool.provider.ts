import { Provider } from '@nestjs/common';
import { Pool } from 'pg';

export const ANALYTICS_APP_REPLICA_PG_POOL = Symbol('ANALYTICS_APP_REPLICA_PG_POOL');

/**
 * Phase 4/ADR-0108: `agno_analytics_app` - this module's own least-
 * privilege role, same credentials `typeorm.config.ts` uses for the
 * primary - pointed at the analytics read replica instead
 * (`ANALYTICS_REPLICA_DB_HOST`/`PORT`). This is the connection ADR-0108's
 * Decision section names explicitly: "every live dashboard load, report-
 * builder query, and BI-connector request... go to the replica, via a
 * second pool with the same credentials pointed at a different host."
 *
 * Unlike `migrator-replica-pool.provider.ts` (which bypasses RLS entirely
 * as the schema owner, for cross-tenant batch refresh jobs), this pool is
 * RLS-scoped normally - `agno_analytics_app` is not the table owner. Every
 * query through this pool must go through `withTenantScopedClient`
 * (`with-tenant-scoped-client.ts`), never a bare `pool.query()`.
 *
 * No `options: '-c TimeZone=UTC'` here (unlike the migrator replica pool) -
 * `MetricQueryEngineService` never buckets by calendar day/month itself,
 * it only reads `period_start`/`period_end` values the refresh jobs
 * already computed, so there is no `date_trunc` call on this connection to
 * be timezone-sensitive about.
 */
export const analyticsAppReplicaPoolProvider: Provider = {
  provide: ANALYTICS_APP_REPLICA_PG_POOL,
  useFactory: (): Pool =>
    new Pool({
      host: process.env.ANALYTICS_REPLICA_DB_HOST ?? process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.ANALYTICS_REPLICA_DB_PORT ?? process.env.DB_PORT ?? 5432),
      user: process.env.DB_USERNAME ?? 'agno_analytics_app',
      password: process.env.DB_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
      max: 5,
    }),
};
