import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module 05 Phase 7 (§6.1, ADR-0071): `intraday.queue_metrics_snapshot` -
 * the queue-side equivalent of `AdherenceEvent`'s role for
 * `AgentLiveState` (Phase 3/4) - a Postgres degraded-fallback source for
 * `QueueLiveStateQueryService`, which previously had none (Phase 4's own
 * checklist flagged this explicitly as not done).
 *
 * Not partitioned like `AdherenceEvent` - expected volume (one row per
 * `queue.metrics_updated` event, far fewer queues than employees
 * platform-wide) is much lower than the per-employee event log
 * partitioning was built for. Retention is a flat 7 days, pruned by
 * `QueueMetricsSnapshotRetentionSchedulerService` - this table backs
 * degraded-mode display only, not analytics (the rollup tables already
 * own that).
 */
export class QueueMetricsSnapshotSchema1700000500000 implements MigrationInterface {
  name = 'QueueMetricsSnapshotSchema1700000500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE intraday.queue_metrics_snapshot (
        id                      uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id               uuid NOT NULL,
        queue_id                uuid NOT NULL,
        current_volume          integer NOT NULL,
        agents_available        integer NOT NULL,
        agents_on_call          integer NOT NULL,
        forecasted_volume       integer,
        service_level_current   numeric,
        service_level_target    numeric,
        captured_at             timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id)
      );
    `);
    // The only access pattern: "the most recent snapshot for this queue."
    await queryRunner.query(`
      CREATE INDEX idx_queue_metrics_snapshot_tenant_queue_captured_at
      ON intraday.queue_metrics_snapshot (tenant_id, queue_id, captured_at DESC);
    `);

    await queryRunner.query(`ALTER TABLE intraday.queue_metrics_snapshot ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON intraday.queue_metrics_snapshot FOR ALL
      USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
    `);

    await queryRunner.query(`GRANT SELECT, INSERT ON intraday.queue_metrics_snapshot TO agno_intraday_app;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS intraday.queue_metrics_snapshot;`);
  }
}
