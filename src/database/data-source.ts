import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import * as dotenv from 'dotenv';
import { entities } from '../modules/entities';

dotenv.config();

export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  // The CLI (migrations) runs as agno_migrator; the running application uses
  // agno_app (see src/database/typeorm.config.ts). Never share credentials
  // between the two - that would collapse the two-role split ADR-0002/§2.2
  // rule 2 depends on.
  username: process.env.DB_MIGRATION_USERNAME ?? 'agno_migrator',
  password: process.env.DB_MIGRATION_PASSWORD ?? 'changeme_local_only',
  database: process.env.DB_DATABASE ?? 'agno_wfm',
  entities,
  migrations: [__dirname + '/migrations/*.{ts,js}'],
  // Phase 6 (Module 04) fix: without a default `schema`, TypeORM's own
  // migration-tracking table (bare name `migrations`, no schema qualifier)
  // resolves through `agno_migrator`'s search_path
  // (`core, org, forecasting, scheduling, public`) to whichever schema it
  // finds writable first - which, once `scheduling`/`forecasting` existed
  // too, was `scheduling.migrations`, not anything owned by this
  // repo. Discovered running this app's migrations against the same shared
  // Postgres Module 03/04 use: nothing broke (Module 04's own real revision
  // state lives in `scheduling.alembic_version`, a different table name),
  // but this app's migration history had no home of its own. `schema:
  // 'core'` scopes the tracking table into a schema this app actually
  // owns - the same "give every service's own migration-tracking table an
  // owned home" principle `scheduling-service/migrations/env.py`'s own
  // `version_table_schema` fix already applies.
  schema: 'core',
  // Hard-disabled, not just defaulted: schema drift must only ever happen
  // through a reviewed migration file. See ADR-0001.
  synchronize: false,
  logging: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
};

export const AppDataSource = new DataSource(dataSourceOptions);
