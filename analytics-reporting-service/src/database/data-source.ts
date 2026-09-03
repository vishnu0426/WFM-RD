import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import * as dotenv from 'dotenv';
import { entities } from './entities';

dotenv.config();

/**
 * CLI-facing DataSource (`npm run migration:*`), mirrors every other
 * service's own `src/database/data-source.ts`. Runs as `agno_migrator`,
 * never the runtime `agno_analytics_app` role (`typeorm.config.ts`) - same
 * two-role split ADR-0002/ADR-0093 depend on. This same `agno_migrator`
 * credential is also reused, out-of-band from this file, for the Phase 2+
 * materialized-view refresh jobs' cross-schema *source* reads against the
 * analytics read replica (ADR-0108/ADR-0098's precedent) - not wired here,
 * since that is a runtime read path, not a migration.
 */
export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_MIGRATION_USERNAME ?? 'agno_migrator',
  password: process.env.DB_MIGRATION_PASSWORD ?? 'changeme_local_only',
  database: process.env.DB_DATABASE ?? 'agno_wfm',
  entities,
  migrations: [__dirname + '/migrations/*.{ts,js}'],
  // Without an explicit `schema`, TypeORM's bare `migrations` table resolves
  // through `agno_migrator`'s shared search_path to whichever schema it
  // finds writable first, not one this service owns - same fix every other
  // service's data-source.ts documents for its own migrations table.
  schema: 'analytics',
  synchronize: false,
  logging: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
};

export const AppDataSource = new DataSource(dataSourceOptions);
