import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import * as dotenv from 'dotenv';
import { entities } from './entities';

dotenv.config();

/**
 * CLI-facing DataSource (`npm run migration:*`), mirrors the root app's
 * `src/database/data-source.ts` exactly. Runs as `agno_migrator`, never
 * the runtime `agno_intraday_app` role (`typeorm.config.ts`) - same
 * two-role split ADR-0002/ADR-0066 depend on.
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
  // Same fix root's data-source.ts documents for its own migration-tracking
  // table: without an explicit `schema`, TypeORM's bare `migrations` table
  // resolves through `agno_migrator`'s shared search_path
  // (`core, org, forecasting, scheduling, intraday, public`) to whichever
  // schema it finds writable first, not one this service owns.
  schema: 'intraday',
  synchronize: false,
  logging: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
};

export const AppDataSource = new DataSource(dataSourceOptions);
