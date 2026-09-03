import { registerAs } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { entities } from './entities';

/**
 * Runtime connection used by the NestJS application - `agno_analytics_app`,
 * NOT `agno_migrator` (`data-source.ts`). Mirrors every other service's own
 * `src/database/typeorm.config.ts` split. This is the *primary* connection
 * only (`SavedReport`/`MetricDefinition`/`DashboardWidget` CRUD, and the
 * MV refresh jobs' writes into `analytics_mv`); the *read-replica* pool
 * that serves live dashboard/report-builder/BI-connector reads against
 * `analytics_mv` (§0.6/ADR-0108) is a separate connection, introduced in
 * Phase 2 once the replica itself is wired up - not this file.
 */
export default registerAs('database', (): TypeOrmModuleOptions => ({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'agno_analytics_app',
  password: process.env.DB_PASSWORD ?? 'changeme_local_only',
  database: process.env.DB_DATABASE ?? 'agno_wfm',
  entities,
  // Migrations run out-of-band via `npm run migration:run`
  // (data-source.ts, agno_migrator credentials) - never at application
  // boot, and never schema-synced. See ADR-0016.
  migrationsRun: false,
  synchronize: false,
  logging: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
}));
