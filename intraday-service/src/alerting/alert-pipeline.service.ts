import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { PubSub } from 'graphql-subscriptions';
import { DataSource, In, IsNull, Not } from 'typeorm';
import { withTenantConnection } from '../database/with-tenant-connection';
import { GRAPHQL_PUBSUB } from '../graphql/pubsub.provider';
import { alertRaisedTrigger } from '../graphql/subscription-triggers';
import { AlertPolicyService } from './alert-policy.service';
import { Alert, AlertSeverity } from './entities/alert.entity';

export interface AlertCandidate {
  tenantId: string;
  alertType: string;
  queueId: string | null;
  severity: AlertSeverity;
}

/**
 * §5a's full pipeline stage, in one place, sitting between the raw NATS
 * consumer (`AlertEngineService`, called from `QueueMetricsUpdatedConsumerService`)
 * and the point `alertRaised` is actually published - not logic scattered
 * across the consumer, per §5a point 4's own explicit ask.
 */
@Injectable()
export class AlertPipelineService {
  private readonly logger = new Logger(AlertPipelineService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly policyService: AlertPolicyService,
    @Inject(GRAPHQL_PUBSUB) private readonly pubSub: PubSub,
  ) {}

  async raiseAlert(candidate: AlertCandidate): Promise<void> {
    const now = new Date();
    await withTenantConnection(this.dataSource, candidate.tenantId, async (manager) => {
      const policy = await this.policyService.getPolicy(manager, candidate.tenantId);
      const repository = manager.getRepository(Alert);

      // The most recent non-resolved alert for this exact root cause -
      // whether it's within the dedup window or not, it's what a new
      // trigger gets linked to via dedup_group_id.
      const mostRecent = await repository.findOne({
        where: {
          tenantId: candidate.tenantId,
          queueId: candidate.queueId ?? IsNull(),
          alertType: candidate.alertType,
          status: Not('resolved'),
        },
        order: { createdAt: 'DESC' },
      });

      // §5a point 1: repeat triggers within the grouping window collapse
      // into the existing row - no new row, no publish.
      if (mostRecent && withinMinutes(mostRecent.createdAt, now, policy.dedupWindowMinutes)) {
        mostRecent.lastTriggeredAt = now;
        await repository.save(mostRecent);
        return;
      }

      // §5a point 2(b): already acknowledged recently - don't re-notify.
      const recentlyAcknowledged =
        mostRecent?.status === 'acknowledged' &&
        mostRecent.acknowledgedAt !== null &&
        withinMinutes(mostRecent.acknowledgedAt, now, policy.suppressionAckWindowMinutes);

      // §5a point 2(a): tenant-configurable suppression rule match.
      const suppressedByRule = this.policyService.matchesSuppressionRule(
        policy.suppressionRules,
        candidate.alertType,
        candidate.queueId,
        now,
      );

      const alert = new Alert();
      alert.id = randomUUID();
      alert.tenantId = candidate.tenantId;
      alert.alertType = candidate.alertType;
      alert.severity = candidate.severity;
      alert.orgUnitId = null;
      alert.queueId = candidate.queueId;
      // Linked to the prior alert's group even outside the dedup window,
      // so a supervisor/auditor can query "every alert for this recurring
      // issue," not just the ones close enough in time to have collapsed.
      alert.dedupGroupId = mostRecent?.dedupGroupId ?? randomUUID();
      alert.createdAt = now;
      alert.lastTriggeredAt = now;
      alert.escalatedAt = null;
      alert.acknowledgedBy = null;
      alert.acknowledgedAt = null;
      alert.resolvedAt = null;
      // §2.2 rule 4: suppressed is a real, queryable/auditable outcome, not a silent drop.
      alert.status = recentlyAcknowledged || suppressedByRule ? 'suppressed' : 'open';

      await repository.insert(alert);

      if (alert.status === 'open') {
        await this.publishAlertRaised(alert);
      } else {
        this.logger.log(
          `Alert ${alert.id} (tenant ${alert.tenantId}, ${alert.alertType}) suppressed - ${
            recentlyAcknowledged ? 'recently acknowledged' : 'matched a suppression rule'
          }`,
        );
      }
    });
  }

  /** Auto-resolution - no `resolveAlert` mutation exists in §4.1, so this is the only path to `status: 'resolved'` (design doc §B). */
  async resolveAlert(tenantId: string, queueId: string | null, alertType: string): Promise<void> {
    await withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const repository = manager.getRepository(Alert);
      const active = await repository.findOne({
        where: {
          tenantId,
          queueId: queueId ?? IsNull(),
          alertType,
          status: In(['open', 'acknowledged', 'suppressed']),
        },
        order: { createdAt: 'DESC' },
      });
      if (!active) {
        return;
      }
      active.status = 'resolved';
      active.resolvedAt = new Date();
      await repository.save(active);
    });
  }

  /** Public so `AlertEscalationSchedulerService` can reuse it to re-publish on escalation. */
  async publishAlertRaised(alert: Alert): Promise<void> {
    await this.pubSub.publish(alertRaisedTrigger(alert.tenantId), {
      alertRaised: {
        id: alert.id,
        alertType: alert.alertType,
        severity: alert.severity,
        orgUnitId: alert.orgUnitId,
        queueId: alert.queueId,
        status: alert.status,
        dedupGroupId: alert.dedupGroupId,
        createdAt: alert.createdAt,
        lastTriggeredAt: alert.lastTriggeredAt,
        escalatedAt: alert.escalatedAt,
        acknowledgedBy: alert.acknowledgedBy,
        acknowledgedAt: alert.acknowledgedAt,
        resolvedAt: alert.resolvedAt,
      },
    });
  }
}

function withinMinutes(from: Date, to: Date, minutes: number): boolean {
  return to.getTime() - from.getTime() < minutes * 60_000;
}
