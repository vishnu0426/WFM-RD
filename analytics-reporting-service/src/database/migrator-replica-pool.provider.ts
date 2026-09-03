import { Provider } from '@nestjs/common';
import { Pool } from 'pg';

export const MIGRATOR_REPLICA_PG_POOL = Symbol('MIGRATOR_REPLICA_PG_POOL');

/**
 * Phase 2/ADR-0108: `agno_migrator`, same credentials as `migrator-pool.
 * provider.ts`, pointed at the analytics **read replica**
 * (`ANALYTICS_REPLICA_DB_HOST`/`ANALYTICS_REPLICA_DB_PORT`) instead of the
 * primary - the direct Postgres extension of ADR-0098's "reuse the
 * migrator credential, don't provision a new role" precedent to a second
 * host. `agno_migrator` already owns every schema on the shared instance
 * (`compliance`, `forecasting`, etc.), and Postgres roles/grants replicate
 * with the instance, so this same credential's grants apply unmodified on
 * the replica - reading `compliance.adherence_score`/`forecasting.
 * forecast_accuracy_log` cross-tenant needs no new role here either, for
 * the identical RLS-owner-bypass reason `migrator-pool.provider.ts`
 * documents for the write side.
 *
 * `options: '-c TimeZone=UTC'` fixes this pool's session timezone rather
 * than relying on the connecting session's own default (`Asia/Kolkata` on
 * this platform's own local dev Postgres, per ADR-0098's own discovered
 * pitfall: `date_trunc` on a `timestamptz` truncates in the *session's*
 * timezone, not UTC). `MvForecastAccuracyTrendRefreshJobService` uses
 * `date_trunc('day', evaluated_at)` to bucket `forecast_accuracy_log` (which
 * has no pre-existing period bucketing of its own); fixing the session
 * timezone here makes that bucketing deterministic without needing
 * per-employee/per-tenant timezone resolution the way ADR-0099 built for
 * Module 08's own rollup - `ForecastAccuracyLog` carries no tenant/org-unit
 * timezone to resolve against in the first place, so "UTC calendar day" is
 * this table's own disclosed simplification, not a workaround for a bug.
 *
 * `ANALYTICS_REPLICA_DB_HOST` defaults to the same primary host - see this
 * file's own `.env.example` entry and ADR-0108's consequences section:
 * `docker-compose.yml` never models a read replica for any service in this
 * platform (its own header names this as Terraform's job), so a pure local
 * `docker-compose up` with no separately-provisioned standby still boots
 * this service correctly, just without genuine replica isolation - the
 * same "real infra is Terraform's job, local dev gets an honest
 * approximation" posture as every other Terraform-deferred gap already
 * flagged in this platform's Phase 1 checklists.
 */
export const migratorReplicaPoolProvider: Provider = {
  provide: MIGRATOR_REPLICA_PG_POOL,
  useFactory: (): Pool =>
    new Pool({
      host: process.env.ANALYTICS_REPLICA_DB_HOST ?? process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.ANALYTICS_REPLICA_DB_PORT ?? process.env.DB_PORT ?? 5432),
      user: process.env.DB_MIGRATION_USERNAME ?? 'agno_migrator',
      password: process.env.DB_MIGRATION_PASSWORD ?? 'changeme_local_only',
      database: process.env.DB_DATABASE ?? 'agno_wfm',
      options: '-c TimeZone=UTC',
      max: 2,
    }),
};
