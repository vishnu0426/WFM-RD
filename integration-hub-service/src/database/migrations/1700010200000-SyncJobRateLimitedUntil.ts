import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * §5a's reactive backoff (`withBackoffRetry`) already detects every real
 * provider rate-limit breach across all four batch adapters - what's
 * missing is a live signal for a `SyncJob` that's mid-retry: today the row
 * sits at `status: running` throughout, indistinguishable from a merely
 * slow sync. A nullable timestamp, not a new `status` value - the job
 * genuinely is still running/retrying, not in some other terminal-ish
 * state, and a new status would need `sync_job_status_check`'s CHECK
 * constraint migrated for no real benefit over "this running job is
 * currently backing off until approximately X." Never explicitly cleared -
 * once a job reaches a terminal status this column is just a historical
 * artifact of its last backoff wait, and callers only read it while
 * `status = 'running'`.
 */
export class SyncJobRateLimitedUntil1700010200000 implements MigrationInterface {
  name = 'SyncJobRateLimitedUntil1700010200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE integration_hub.sync_job
      ADD COLUMN rate_limited_until timestamptz NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE integration_hub.sync_job
      DROP COLUMN rate_limited_until
    `);
  }
}
