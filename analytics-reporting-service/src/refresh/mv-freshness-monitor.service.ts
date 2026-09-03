import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Pool } from 'pg';
import { MIGRATOR_PG_POOL } from '../database/migrator-pool.provider';
import { MIGRATOR_REPLICA_PG_POOL } from '../database/migrator-replica-pool.provider';
import { MetricsService } from '../common/metrics/metrics.service';
import { CADENCE_SECONDS } from './mv-refresh-cadence';

interface LineageRow {
  view_name: string;
  refresh_cadence: 'hourly' | 'daily';
  refreshed_at: Date | null;
}

/**
 * Phase 2 (§0.5/§7): samples `mv_lineage`/replica lag on its own schedule,
 * independently of whether any refresh job tick actually ran. Deliberately
 * separate from the refresh jobs themselves - a gauge only ever updated by
 * a *successful* tick would keep reading "fresh" forever if a job silently
 * stopped running at all, exactly the failure mode this platform's own
 * on-call convention (§0.5) exists to catch (same reasoning as every other
 * service's liveness-vs-readiness split: the thing that detects a problem
 * must not depend on the broken thing continuing to run).
 *
 * `analytics_mv_refresh_lag_seconds` is left **unset** (absent from
 * `/metrics`, not `0`) for a view whose `refreshed_at` is still `NULL` -
 * "never refreshed" and "just refreshed, perfectly on time" are different
 * facts; collapsing them to the same number would hide the former. This
 * works because it is a *labeled* Gauge (`labelNames: ['view_name']`) -
 * prom-client only creates a time series for a label combination once
 * `.set()` is actually called with it, so a view never sampled has no
 * series at all.
 *
 * `analytics_replica_lag_seconds` does **not** get the same absence
 * guarantee, and this is a disclosed prom-client limitation, not an
 * oversight: it is an *unlabeled* Gauge, and prom-client initializes an
 * unlabeled Gauge to `0` the moment it is registered, before `.set()` is
 * ever called - confirmed in this file's own unit test, not assumed. This
 * code still skips calling `.set()` when `pg_is_in_recovery()` is `false`
 * (the honest local-dev fallback, `ANALYTICS_REPLICA_DB_HOST` defaulting
 * to the primary), but the metric will read `0` from process boot until
 * either a real replica connects or someone reads this comment - a real
 * alerting rule on this metric should pair it with
 * `analytics_mv_refresh_job_runs_total`'s own activity (a replica with
 * zero *and* no refresh jobs ever completing is a very different signal
 * than zero with jobs succeeding) rather than trusting `0` alone to mean
 * "healthy." Revisit with a paired `analytics_replica_configured` gauge if
 * this ambiguity causes a real false-negative page.
 */
@Injectable()
export class MvFreshnessMonitorService {
  private readonly logger = new Logger(MvFreshnessMonitorService.name);

  constructor(
    @Inject(MIGRATOR_PG_POOL) private readonly primaryPool: Pool,
    @Inject(MIGRATOR_REPLICA_PG_POOL) private readonly replicaPool: Pool,
    private readonly metrics: MetricsService,
  ) {}

  @Cron('*/5 * * * *')
  async sample(): Promise<void> {
    await Promise.all([this.sampleRefreshLag(), this.sampleReplicaLag()]);
  }

  private async sampleRefreshLag(): Promise<void> {
    try {
      const { rows } = await this.primaryPool.query<LineageRow>(
        `SELECT view_name, refresh_cadence, refreshed_at FROM analytics_mv.mv_lineage;`,
      );
      const now = Date.now();
      for (const row of rows) {
        if (!row.refreshed_at) {
          continue;
        }
        const secondsSinceRefresh = (now - row.refreshed_at.getTime()) / 1000;
        const lag = secondsSinceRefresh - CADENCE_SECONDS[row.refresh_cadence];
        this.metrics.mvRefreshLagSeconds.set({ view_name: row.view_name }, lag);
      }
    } catch (err) {
      this.logger.error(`mv_lineage freshness sample failed: ${(err as Error).message}`);
    }
  }

  private async sampleReplicaLag(): Promise<void> {
    try {
      const { rows } = await this.replicaPool.query<{ in_recovery: boolean; lag_seconds: number | null }>(
        `SELECT pg_is_in_recovery() AS in_recovery,
                EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) AS lag_seconds;`,
      );
      const row = rows[0];
      if (!row?.in_recovery || row.lag_seconds === null) {
        return;
      }
      this.metrics.replicaLagSeconds.set(row.lag_seconds);
    } catch (err) {
      this.logger.error(`Replica lag sample failed: ${(err as Error).message}`);
    }
  }
}
