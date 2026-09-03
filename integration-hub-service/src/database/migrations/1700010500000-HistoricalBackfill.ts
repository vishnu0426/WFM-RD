import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tenant Admin Integration Management, WP5 (plan decision #6). Extends
 * `sync_job` with a fourth `sync_type: historical` (date-ranged, chunked,
 * resumable) alongside the existing `full`/`incremental`/`streaming`, and
 * adds `historical_backfill_chunk` - one row per date-range chunk of a
 * parent historical `SyncJob`, each with its own status and checkpoint
 * cursor, so a failed backfill resumes from its last completed chunk
 * instead of restarting the whole range.
 *
 * IMPORTANT (BACKEND GAP, disclosed rather than hidden): as of this
 * migration, zero provider adapters implement the new
 * `HistoricalConnectorAdapter` interface (`sync/historical/`) - checked
 * against every file in `sync/batch/providers/`, none of which accept a
 * date range, and the on-prem collector is confirmed real-time-only. This
 * mirrors the exact precedent this codebase already set for
 * `BatchConnectorAdapter` itself ("Phase 2 builds the shape and the
 * runner that calls it; zero adapters are registered until Phase 3") -
 * the orchestration is real, but "Start Import" honestly reports
 * `HISTORICAL_IMPORT_NOT_SUPPORTED` for every current provider rather
 * than faking a fetch.
 */
export class HistoricalBackfill1700010500000 implements MigrationInterface {
  name = 'HistoricalBackfill1700010500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tenantIdExpr = `current_setting('app.current_tenant_id', true)::uuid`;

    await queryRunner.query(`
      ALTER TABLE integration_hub.sync_job
      DROP CONSTRAINT sync_job_sync_type_check;
    `);
    await queryRunner.query(`
      ALTER TABLE integration_hub.sync_job
      ADD CONSTRAINT sync_job_sync_type_check
      CHECK (sync_type IN ('full', 'incremental', 'streaming', 'historical'));
    `);
    // `cancelled` - a real, distinct outcome from `failed` for "Cancel
    // Backfill" (spec §36). Only `sync_job.status` is widened;
    // `integration_connector.last_sync_status_check` deliberately keeps its
    // original five values - nothing ever writes `cancelled` there.
    await queryRunner.query(`
      ALTER TABLE integration_hub.sync_job
      DROP CONSTRAINT sync_job_status_check;
    `);
    await queryRunner.query(`
      ALTER TABLE integration_hub.sync_job
      ADD CONSTRAINT sync_job_status_check
      CHECK (status IN ('queued', 'running', 'completed', 'failed', 'partial_failure', 'cancelled'));
    `);
    await queryRunner.query(`
      ALTER TABLE integration_hub.sync_job
      ADD COLUMN dataset_key varchar(100),
      ADD COLUMN range_start date,
      ADD COLUMN range_end date,
      ADD COLUMN records_found integer,
      ADD COLUMN records_duplicate integer;
    `);
    await queryRunner.query(`
      ALTER TABLE integration_hub.sync_job
      ADD CONSTRAINT sync_job_historical_range_check
      CHECK (sync_type <> 'historical' OR (dataset_key IS NOT NULL AND range_start IS NOT NULL AND range_end IS NOT NULL AND range_end >= range_start));
    `);

    await queryRunner.query(`
      CREATE TABLE integration_hub.historical_backfill_chunk (
        id                  uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id           uuid NOT NULL,
        sync_job_id         uuid NOT NULL,
        chunk_index         integer NOT NULL,
        range_start         date NOT NULL,
        range_end           date NOT NULL,
        status              varchar(20) NOT NULL DEFAULT 'queued',
        checkpoint_cursor   jsonb,
        records_found       integer NOT NULL DEFAULT 0,
        records_processed   integer NOT NULL DEFAULT 0,
        records_failed      integer NOT NULL DEFAULT 0,
        records_duplicate   integer NOT NULL DEFAULT 0,
        error_details       jsonb,
        started_at          timestamptz,
        completed_at        timestamptz,
        PRIMARY KEY (id),
        UNIQUE (sync_job_id, chunk_index),
        CONSTRAINT historical_backfill_chunk_sync_job_fk
          FOREIGN KEY (tenant_id, sync_job_id)
          REFERENCES integration_hub.sync_job (tenant_id, id),
        CONSTRAINT historical_backfill_chunk_status_check
          CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        CONSTRAINT historical_backfill_chunk_range_check CHECK (range_end >= range_start)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_historical_backfill_chunk_tenant_sync_job
      ON integration_hub.historical_backfill_chunk (tenant_id, sync_job_id, chunk_index);
    `);

    await queryRunner.query(`ALTER TABLE integration_hub.historical_backfill_chunk ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON integration_hub.historical_backfill_chunk FOR ALL
      USING (tenant_id = ${tenantIdExpr})
      WITH CHECK (tenant_id = ${tenantIdExpr});
    `);
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON integration_hub.historical_backfill_chunk TO agno_integration_hub_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS integration_hub.historical_backfill_chunk;`);
    await queryRunner.query(`
      ALTER TABLE integration_hub.sync_job
      DROP CONSTRAINT IF EXISTS sync_job_historical_range_check;
    `);
    await queryRunner.query(`
      ALTER TABLE integration_hub.sync_job
      DROP COLUMN IF EXISTS dataset_key,
      DROP COLUMN IF EXISTS range_start,
      DROP COLUMN IF EXISTS range_end,
      DROP COLUMN IF EXISTS records_found,
      DROP COLUMN IF EXISTS records_duplicate;
    `);
    await queryRunner.query(`
      ALTER TABLE integration_hub.sync_job
      DROP CONSTRAINT sync_job_sync_type_check;
    `);
    await queryRunner.query(`
      ALTER TABLE integration_hub.sync_job
      ADD CONSTRAINT sync_job_sync_type_check
      CHECK (sync_type IN ('full', 'incremental', 'streaming'));
    `);
    await queryRunner.query(`
      ALTER TABLE integration_hub.sync_job
      DROP CONSTRAINT sync_job_status_check;
    `);
    await queryRunner.query(`
      ALTER TABLE integration_hub.sync_job
      ADD CONSTRAINT sync_job_status_check
      CHECK (status IN ('queued', 'running', 'completed', 'failed', 'partial_failure'));
    `);
  }
}
