import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * "Processing Lag" (Real-Time Integration → Event Ingestion Status) was
 * disclosed as BACKEND GAP because no timestamp anywhere captured when a
 * streaming connector last actually processed an event - `IntegrationConnector
 * .lastSyncAt` exists but is never written by any sync path (batch or
 * streaming), and `SyncJob.startedAt`/`completedAt` are session-window
 * bounds, not per-event activity.
 *
 * `StreamingRelayService.start`'s `onEventForwarded`/`onEventFailed`
 * callbacks (already real - genesys-cloud.adapter.ts and its five sibling
 * relay adapters call these on every genuine event) are the one place a
 * per-event timestamp can honestly be captured. This column is updated
 * alongside `records_processed`/`records_failed` in the same atomic
 * `incrementCounts` UPDATE, so it always reflects true relay activity, not
 * a fabricated liveness signal.
 *
 * Deliberately not named `last_processed_at`/`last_ingested_at`: this marks
 * when this platform last handled an event, not when the event actually
 * happened at the source ACD (no origin timestamp is available at this
 * call site) - the frontend must label the derived metric as staleness
 * ("time since last event"), not true source-to-platform latency.
 */
export class SyncJobLastEventAt1700010700000 implements MigrationInterface {
  name = 'SyncJobLastEventAt1700010700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE integration_hub.sync_job
      ADD COLUMN last_event_at timestamptz NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE integration_hub.sync_job
      DROP COLUMN last_event_at
    `);
  }
}
