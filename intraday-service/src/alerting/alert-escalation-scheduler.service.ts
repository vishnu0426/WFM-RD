import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PubSub } from 'graphql-subscriptions';
import type { Pool } from 'pg';
import { MIGRATOR_PG_POOL } from '../database/migrator-pool.provider';
import { GRAPHQL_PUBSUB } from '../graphql/pubsub.provider';
import { alertRaisedTrigger } from '../graphql/subscription-triggers';

interface EscalationCandidateRow {
  id: string;
  tenant_id: string;
  alert_type: string;
  org_unit_id: string | null;
  queue_id: string | null;
  dedup_group_id: string;
  created_at: Date;
  last_triggered_at: Date;
}

const ESCALATION_QUERY = `
  SELECT a.id, a.tenant_id, a.alert_type, a.org_unit_id, a.queue_id, a.dedup_group_id, a.created_at, a.last_triggered_at
  FROM intraday.alert a
  LEFT JOIN intraday.alert_policy p ON p.tenant_id = a.tenant_id
  WHERE a.status = 'open'
    AND a.severity = 'warning'
    AND a.created_at < now() - (COALESCE(p.escalation_threshold_minutes, 15) || ' minutes')::interval;
`;

/**
 * §5a point 3: "an unacknowledged alert past a defined time threshold
 * escalates... define the escalation policy as tenant-configurable data."
 * Same app-level `@Cron` idiom as every other time-based check in this
 * service (`ShiftStartPreloadSchedulerService`, Phase 3's two scheduler
 * services) - no `pg_cron` precedent exists anywhere in this platform.
 *
 * Uses the migrator-credentialed pool
 * (`database/migrator-pool.provider.ts`) - same reasoning as Phase 3's
 * rollup scheduler: this scan is genuinely cross-tenant (every tenant's
 * stale open alerts in one tick), and RLS's `ENABLE`-not-`FORCE` posture
 * means only the table owner queries across tenants without per-request
 * `app.current_tenant_id` scoping.
 *
 * "Wider notification scope" (§5a point 3) is **not** implemented as real
 * notification fan-out - no delivery mechanism exists in this module
 * (design doc assumption 4). Escalation here is a severity bump
 * (`warning` → `critical`) plus an `alertRaised` re-publish, the only part
 * of "escalation" this module can actually do.
 */
@Injectable()
export class AlertEscalationSchedulerService {
  private readonly logger = new Logger(AlertEscalationSchedulerService.name);
  private ticking = false;

  constructor(
    @Inject(MIGRATOR_PG_POOL) private readonly pool: Pool,
    @Inject(GRAPHQL_PUBSUB) private readonly pubSub: PubSub,
  ) {}

  @Cron('*/5 * * * *')
  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await this.escalateStaleAlerts();
    } catch (err) {
      this.logger.error(`Escalation tick failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async escalateStaleAlerts(): Promise<void> {
    const result = await this.pool.query<EscalationCandidateRow>(ESCALATION_QUERY);
    for (const row of result.rows) {
      const escalatedAt = new Date();
      await this.pool.query(`UPDATE intraday.alert SET severity = 'critical', escalated_at = $2 WHERE id = $1`, [
        row.id,
        escalatedAt,
      ]);
      this.logger.warn(
        `Escalated alert ${row.id} (tenant ${row.tenant_id}, ${row.alert_type}) warning -> critical - past the escalation threshold unacknowledged`,
      );
      await this.pubSub.publish(alertRaisedTrigger(row.tenant_id), {
        alertRaised: {
          id: row.id,
          alertType: row.alert_type,
          severity: 'critical',
          orgUnitId: row.org_unit_id,
          queueId: row.queue_id,
          status: 'open',
          dedupGroupId: row.dedup_group_id,
          createdAt: row.created_at,
          lastTriggeredAt: row.last_triggered_at,
          escalatedAt,
          acknowledgedBy: null,
          acknowledgedAt: null,
          resolvedAt: null,
        },
      });
    }
  }
}
