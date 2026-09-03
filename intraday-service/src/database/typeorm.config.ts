import { registerAs } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { entities } from './entities';

/**
 * Runtime connection used by the NestJS application - `agno_intraday_app`,
 * NOT `agno_migrator` (`data-source.ts`). Mirrors the root app's own
 * `src/database/typeorm.config.ts` split.
 */
export default registerAs('database', (): TypeOrmModuleOptions => ({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'agno_intraday_app',
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
