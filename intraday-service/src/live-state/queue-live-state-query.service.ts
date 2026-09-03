import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { withTenantConnection } from '../database/with-tenant-connection';
import { IntradayRedisService, IntradayRedisUnavailableError } from '../redis/redis.service';
import { QueueMetricsSnapshot } from './entities/queue-metrics-snapshot.entity';
import { QueueLiveStateResult } from './types';

/**
 * §6.1 Phase 7: on a Redis outage, falls back to this queue's most recent
 * `QueueMetricsSnapshot` row (Phase 7) - the queue-side equivalent of
 * `AgentLiveStateQueryService`'s `AdherenceEvent` fallback, closing the
 * gap Phase 4's own checklist explicitly flagged ("a richer per-queue
 * Postgres history... doesn't exist anywhere in this platform"). If no
 * snapshot exists yet (a queue with no `queue.metrics_updated` history at
 * all), falls through to the original, honestly-poorer all-nulls
 * response - a nested, still-honest fallback, not a regression.
 */
@Injectable()
export class QueueLiveStateQueryService {
  private readonly logger = new Logger(QueueLiveStateQueryService.name);

  constructor(
    private readonly redis: IntradayRedisService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async getQueueLiveState(tenantId: string, queueId: string): Promise<QueueLiveStateResult | null> {
    try {
      const record = await this.redis.readQueueLiveState(tenantId, queueId);
      if (!record) {
        return null;
      }
      return {
        queueId,
        currentVolume: record.currentVolume,
        agentsAvailable: record.agentsAvailable,
        agentsOnCall: record.agentsOnCall,
        forecastedVolume: record.forecastedVolume,
        serviceLevelCurrent: record.serviceLevelCurrent,
        serviceLevelTarget: record.serviceLevelTarget,
        dataFreshness: { status: 'ok', lastKnownUpdateAt: new Date(record.lastUpdatedAt) },
      };
    } catch (err) {
      if (!(err instanceof IntradayRedisUnavailableError)) {
        throw err;
      }
      this.logger.warn(
        `Redis unavailable reading QueueLiveState for queue ${queueId} - falling back to the most recent QueueMetricsSnapshot: ${err.message}`,
      );
      return this.degradedFromSnapshot(tenantId, queueId);
    }
  }

  private async degradedFromSnapshot(tenantId: string, queueId: string): Promise<QueueLiveStateResult> {
    const snapshot = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.getRepository(QueueMetricsSnapshot).findOne({
        where: { tenantId, queueId },
        order: { capturedAt: 'DESC' },
      }),
    );
    if (!snapshot) {
      return {
        queueId,
        currentVolume: null,
        agentsAvailable: null,
        agentsOnCall: null,
        forecastedVolume: null,
        serviceLevelCurrent: null,
        serviceLevelTarget: null,
        dataFreshness: { status: 'degraded', lastKnownUpdateAt: null },
      };
    }
    return {
      queueId,
      currentVolume: snapshot.currentVolume,
      agentsAvailable: snapshot.agentsAvailable,
      agentsOnCall: snapshot.agentsOnCall,
      forecastedVolume: snapshot.forecastedVolume,
      serviceLevelCurrent: snapshot.serviceLevelCurrent,
      serviceLevelTarget: snapshot.serviceLevelTarget,
      dataFreshness: { status: 'degraded', lastKnownUpdateAt: snapshot.capturedAt },
    };
  }
}
