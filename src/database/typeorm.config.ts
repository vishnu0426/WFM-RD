import { registerAs } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { entities } from '../modules/entities';

/**
 * Runtime connection used by the NestJS application - agno_app, NOT
 * agno_migrator (src/database/data-source.ts). Keeping these two credential
 * sets distinct is what makes the audit_log GRANT restriction (§2.2 rule 2)
 * meaningful: if the app ran as the migrator it would silently have
 * UPDATE/DELETE on audit_log regardless of what the migration revoked.
 */
export default registerAs('database', (): TypeOrmModuleOptions => ({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'agno_app',
  password: process.env.DB_PASSWORD ?? 'changeme_local_only',
  database: process.env.DB_DATABASE ?? 'agno_wfm',
  entities,
  // Migrations run out-of-band via `npm run migration:run` (data-source.ts,
  // agno_migrator credentials) - never at application boot, and never
  // schema-synced. See ADR-0001.
  migrationsRun: false,
  synchronize: false,
  logging: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
}));
