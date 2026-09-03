import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AdherenceEvent } from '../adherence/entities/adherence-event.entity';
import { withTenantConnection } from '../database/with-tenant-connection';
import { IntradayRedisService, IntradayRedisUnavailableError } from '../redis/redis.service';
import { AgentLiveStateResult } from './types';

/**
 * §6.1's degraded-mode fallback, made real: on a Redis outage, falls back
 * to this employee's most recent `AdherenceEvent` row (Phase 3) rather
 * than a hard failure - §6.1 literally names "the most recent
 * Postgres-persisted AdherenceEvent... as a degraded approximation," and
 * this module now has exactly that data. The approximation is honestly
 * partial: `activityStartedAt`/`adherenceStatus`/`siteId`/`queueId` aren't
 * in `AdherenceEvent` at all, so they come back `null` rather than a
 * fabricated guess - `dataFreshness.status: 'degraded'` is what tells the
 * caller not to trust this as current.
 */
@Injectable()
export class AgentLiveStateQueryService {
  private readonly logger = new Logger(AgentLiveStateQueryService.name);

  constructor(
    private readonly redis: IntradayRedisService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async getAgentLiveState(tenantId: string, employeeId: string): Promise<AgentLiveStateResult | null> {
    try {
      const record = await this.redis.readAgentLiveState(tenantId, employeeId);
      if (!record) {
        return null;
      }
      return {
        employeeId,
        currentActivity: record.currentActivity,
        activityStartedAt: new Date(record.activityStartedAt),
        scheduledActivity: record.scheduledActivity,
        adherenceStatus: record.adherenceStatus,
        siteId: record.siteId,
        queueId: record.queueId,
        dataFreshness: { status: 'ok', lastKnownUpdateAt: new Date(record.lastUpdatedAt) },
      };
    } catch (err) {
      if (!(err instanceof IntradayRedisUnavailableError)) {
        throw err;
      }
      this.logger.warn(
        `Redis unavailable reading AgentLiveState for employee ${employeeId} - falling back to the most recent AdherenceEvent: ${err.message}`,
      );
      return this.degradedFromAdherenceEvent(tenantId, employeeId);
    }
  }

  private async degradedFromAdherenceEvent(tenantId: string, employeeId: string): Promise<AgentLiveStateResult | null> {
    const event = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.getRepository(AdherenceEvent).findOne({
        where: { tenantId, employeeId },
        order: { timestamp: 'DESC' },
      }),
    );
    if (!event) {
      return null;
    }
    return {
      employeeId,
      currentActivity: event.toActivity,
      activityStartedAt: null,
      scheduledActivity: event.scheduledActivity,
      adherenceStatus: null,
      siteId: null,
      queueId: null,
      dataFreshness: { status: 'degraded', lastKnownUpdateAt: event.timestamp },
    };
  }
}
