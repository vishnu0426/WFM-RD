import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { PubSub } from 'graphql-subscriptions';
import { DataSource, In } from 'typeorm';
import { withTenantConnection } from '../database/with-tenant-connection';
import { GRAPHQL_PUBSUB } from '../graphql/pubsub.provider';
import { reallocationSuggestedTrigger } from '../graphql/subscription-triggers';
import { IntradayNatsClientService } from '../nats/nats-client.service';
import { INTRADAY_SUBJECTS, ReallocationSuggestedPayload } from '../nats/subjects';
import { IntradayRedisService } from '../redis/redis.service';
import { QueueLiveStateRecord } from '../redis/types';
import { ReallocationAction } from './entities/reallocation-action.entity';
import { ReallocationExecutionService } from './reallocation-execution.service';
import { toReallocationActionResult } from './types';

/** A concrete, documented threshold, not a tuned/opaque one - a donor queue must be running 10+ percentage points above its own target before it's considered to have spare capacity. */
const SURPLUS_THRESHOLD = 0.1;

/** A conservative, minimal per-suggestion move - moving more than one employee per suggestion is out of scope this phase (design doc assumption 4). */
const EMPLOYEES_PER_SUGGESTION = 1;

interface DonorCandidate {
  queueId: string;
  record: QueueLiveStateRecord;
}

/**
 * §5's own architecture list ("Redis state updater, alert engine,
 * reallocation recommendation engine" all consume `queue.metrics_updated`)
 * - the reallocation-side sibling of Phase 5's `AlertEngineService`, called
 * from `QueueMetricsUpdatedConsumerService` right after the alert-engine
 * call. Detection + persistence live in one service here (unlike Alert's
 * split detector/pipeline) because §5a's dedup/suppression/escalation
 * pipeline is scoped to `Alert` specifically - `ReallocationAction` only
 * needs the lightweight repeat-guard below, not that full stage.
 */
@Injectable()
export class ReallocationRecommendationService {
  private readonly logger = new Logger(ReallocationRecommendationService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly redis: IntradayRedisService,
    private readonly nats: IntradayNatsClientService,
    private readonly execution: ReallocationExecutionService,
    private readonly config: ConfigService,
    @Inject(GRAPHQL_PUBSUB) private readonly pubSub: PubSub,
  ) {}

  async evaluateQueueMetrics(tenantId: string, queueId: string, record: QueueLiveStateRecord): Promise<void> {
    if (record.serviceLevelCurrent === null || record.serviceLevelTarget === null) {
      return;
    }
    if (record.serviceLevelCurrent >= record.serviceLevelTarget) {
      return;
    }

    const donor = await this.findDonorQueue(tenantId, queueId);
    if (!donor) {
      return;
    }

    const members = await this.redis.listQueueMembers(tenantId, donor.queueId);
    if (members.length === 0) {
      // The donor is metrics-overstaffed but no tracked agent identity
      // exists yet - never fabricate an affected_employee_ids entry.
      return;
    }
    const affectedEmployeeIds = members.slice(0, EMPLOYEES_PER_SUGGESTION);

    await withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const repository = manager.getRepository(ReallocationAction);

      // Repeat-guard: don't spam a new suggestion for the same donor/target
      // pair on every tick while one is already pending action.
      const existing = await repository.findOne({
        where: {
          tenantId,
          fromQueueId: donor.queueId,
          toQueueId: queueId,
          status: In(['suggested', 'approved']),
        },
      });
      if (existing) {
        return;
      }

      const action = new ReallocationAction();
      action.id = randomUUID();
      action.tenantId = tenantId;
      action.triggeredBy = 'system_recommendation';
      action.fromQueueId = donor.queueId;
      action.toQueueId = queueId;
      action.affectedEmployeeIds = affectedEmployeeIds;
      action.reason = `Queue ${queueId} is below its service-level target (${record.serviceLevelCurrent} < ${record.serviceLevelTarget}) while queue ${donor.queueId} has surplus capacity.`;
      action.aiRationale = {
        triggerMetric: 'service_level_current',
        toQueue: {
          queueId,
          serviceLevelCurrent: record.serviceLevelCurrent,
          serviceLevelTarget: record.serviceLevelTarget,
        },
        fromQueue: {
          queueId: donor.queueId,
          serviceLevelCurrent: donor.record.serviceLevelCurrent,
          serviceLevelTarget: donor.record.serviceLevelTarget,
          agentsAvailable: donor.record.agentsAvailable,
        },
        heuristic: 'largest_service_level_surplus_donor',
        surplusThreshold: SURPLUS_THRESHOLD,
      };
      action.status = 'suggested';
      action.createdAt = new Date();
      action.executedAt = null;

      await repository.save(action);
      await this.publishSuggested(action);

      if (this.isAutoExecuteEnabled()) {
        await this.execution.applyReallocation(
          tenantId,
          action.fromQueueId,
          action.toQueueId,
          action.affectedEmployeeIds,
        );
        action.status = 'auto_executed';
        action.executedAt = new Date();
        await repository.save(action);
      }
    });
  }

  /** §8's "off by default" - a plain env var, not the root app's `org.feature_flags` (ADR-0070's own cross-module-avoidance reasoning, matching ADR-0069's `alert_policy`). */
  private isAutoExecuteEnabled(): boolean {
    return this.config.get<string>('INTRADAY_REALLOCATION_AUTO_EXECUTE_ENABLED', 'false') === 'true';
  }

  /** Largest-surplus donor among this tenant's recently-active queues, excluding the breaching queue itself. */
  private async findDonorQueue(tenantId: string, excludeQueueId: string): Promise<DonorCandidate | null> {
    const trackedQueueIds = await this.redis.listTrackedQueues(tenantId);
    let best: DonorCandidate | null = null;
    let bestSurplus = SURPLUS_THRESHOLD;

    for (const candidateId of trackedQueueIds) {
      if (candidateId === excludeQueueId) {
        continue;
      }
      const candidate = await this.redis.readQueueLiveState(tenantId, candidateId);
      if (!candidate || candidate.serviceLevelCurrent === null || candidate.serviceLevelTarget === null) {
        continue;
      }
      if (candidate.agentsAvailable <= 0) {
        continue;
      }
      const surplus = candidate.serviceLevelCurrent - candidate.serviceLevelTarget;
      if (surplus > bestSurplus) {
        bestSurplus = surplus;
        best = { queueId: candidateId, record: candidate };
      }
    }
    return best;
  }

  private async publishSuggested(action: ReallocationAction): Promise<void> {
    const payload: ReallocationSuggestedPayload = {
      tenantId: action.tenantId,
      reallocationActionId: action.id,
      fromQueueId: action.fromQueueId,
      toQueueId: action.toQueueId,
      affectedEmployeeIds: action.affectedEmployeeIds,
      reason: action.reason,
    };
    try {
      await this.nats.publish(INTRADAY_SUBJECTS.REALLOCATION_SUGGESTED, payload as unknown as Record<string, unknown>);
    } catch (err) {
      this.logger.warn(`Failed to publish reallocation.suggested for ${action.id}: ${(err as Error).message}`);
    }
    await this.pubSub.publish(reallocationSuggestedTrigger(action.tenantId), {
      reallocationSuggested: toReallocationActionResult(action),
    });
  }
}
