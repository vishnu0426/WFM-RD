import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';
import {
  agentLiveStateKey,
  ingestionIdempotencyKey,
  parseTrackedEmployeeKey,
  parseTrackedQueueKey,
  queueAgentsKey,
  queueLiveStateKey,
  trackedEmployeeKey,
  trackedQueueKey,
  trackedQueueScanPattern,
  TRACKED_EMPLOYEE_SCAN_PATTERN,
} from './keys';
import { AgentLiveStateFields, AgentLiveStateRecord, QueueLiveStateFields, QueueLiveStateRecord } from './types';

export class IntradayRedisUnavailableError extends Error {
  constructor(operation: string, cause: unknown) {
    super(`Redis unavailable during ${operation}: ${(cause as Error).message}`);
    this.name = 'IntradayRedisUnavailableError';
  }
}

/**
 * ADR-0062: fail-*visible*, the opposite posture of the root app's
 * `src/common/redis/redis.service.ts`. Every data-path method here
 * (`write*`/`read*`/`acquireIngestionIdempotencyLock`) lets a Redis error
 * propagate as `IntradayRedisUnavailableError` rather than swallowing it -
 * a caller that can't distinguish "Redis said no data" from "Redis is
 * unreachable" cannot implement §6.1's staleness contract correctly.
 * `ping()` is the one exception: it exists specifically to report degraded
 * status (readiness now, the future `dataFreshness` envelope in Phase 4/7),
 * so it must never itself throw.
 *
 * `write*` methods take `Partial<...Fields>` (Phase 2): the
 * agent-state-changed consumer only ever knows `currentActivity`/
 * `activityStartedAt`/`siteId`/`queueId`, `ScheduledActivityService` only
 * ever knows `scheduledActivity` - both write the same hash independently
 * and must never clobber the other's fields. A key entirely absent from
 * the object is left untouched; a key present with value `null` is
 * cleared (`HDEL`); a key present with a real value is set (`HSET`) - see
 * `writeHash` below.
 */
@Injectable()
export class IntradayRedisService {
  private readonly logger = new Logger(IntradayRedisService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  getClient(): Redis {
    return this.client;
  }

  /** Never throws - callers (readiness, the future `dataFreshness` envelope) need a status, not an exception. */
  async ping(): Promise<{ ok: boolean; latencyMs: number }> {
    const startedAt = Date.now();
    try {
      await this.client.ping();
      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (err) {
      this.logger.warn(`Redis PING failed: ${(err as Error).message}`);
      return { ok: false, latencyMs: Date.now() - startedAt };
    }
  }

  async writeAgentLiveState(
    tenantId: string,
    employeeId: string,
    fields: Partial<AgentLiveStateFields>,
  ): Promise<void> {
    const key = agentLiveStateKey(tenantId, employeeId);
    try {
      await writeHash(this.client, key, { ...fields, lastUpdatedAt: new Date().toISOString() });
    } catch (err) {
      throw new IntradayRedisUnavailableError(`writeAgentLiveState(${key})`, err);
    }
  }

  async readAgentLiveState(tenantId: string, employeeId: string): Promise<AgentLiveStateRecord | null> {
    const key = agentLiveStateKey(tenantId, employeeId);
    try {
      const raw = await this.client.hgetall(key);
      if (Object.keys(raw).length === 0) {
        return null;
      }
      return {
        currentActivity: raw.currentActivity,
        activityStartedAt: raw.activityStartedAt,
        scheduledActivity: raw.scheduledActivity ?? null,
        adherenceStatus: raw.adherenceStatus ?? null,
        siteId: raw.siteId ?? null,
        queueId: raw.queueId ?? null,
        lastUpdatedAt: raw.lastUpdatedAt,
      };
    } catch (err) {
      throw new IntradayRedisUnavailableError(`readAgentLiveState(${key})`, err);
    }
  }

  async writeQueueLiveState(tenantId: string, queueId: string, fields: Partial<QueueLiveStateFields>): Promise<void> {
    const key = queueLiveStateKey(tenantId, queueId);
    try {
      await writeHash(this.client, key, { ...fields, lastUpdatedAt: new Date().toISOString() });
    } catch (err) {
      throw new IntradayRedisUnavailableError(`writeQueueLiveState(${key})`, err);
    }
  }

  async readQueueLiveState(tenantId: string, queueId: string): Promise<QueueLiveStateRecord | null> {
    const key = queueLiveStateKey(tenantId, queueId);
    try {
      const raw = await this.client.hgetall(key);
      if (Object.keys(raw).length === 0) {
        return null;
      }
      return {
        currentVolume: Number(raw.currentVolume),
        agentsAvailable: Number(raw.agentsAvailable),
        agentsOnCall: Number(raw.agentsOnCall),
        forecastedVolume: raw.forecastedVolume === undefined ? null : Number(raw.forecastedVolume),
        serviceLevelCurrent: raw.serviceLevelCurrent === undefined ? null : Number(raw.serviceLevelCurrent),
        serviceLevelTarget: raw.serviceLevelTarget === undefined ? null : Number(raw.serviceLevelTarget),
        lastUpdatedAt: raw.lastUpdatedAt,
      };
    } catch (err) {
      throw new IntradayRedisUnavailableError(`readQueueLiveState(${key})`, err);
    }
  }

  /**
   * `SET key 1 EX ttl NX` - atomic "did this ingestion request win the
   * dedup race." Unlike root's `RedisService.setIfNotExists` (ADR-0047,
   * fails open to `true` on a Redis error), this fails *closed*: this
   * service cannot guarantee it won't double-publish an ACD-retried event to
   * NATS if it can't check Redis, and Phase 1's downstream (nothing yet) and
   * Phase 2+'s consumers are not built to tolerate that - ADR-0062's
   * fail-visible posture applied to a write path, not just reads.
   * `IngestionService` maps a thrown `IntradayRedisUnavailableError` here to
   * `503`, which the calling ACD/CCaaS system is already expected to retry.
   */
  async acquireIngestionIdempotencyLock(tenantId: string, sourceEventId: string, ttlSeconds: number): Promise<boolean> {
    const key = ingestionIdempotencyKey(tenantId, sourceEventId);
    try {
      const result = await this.client.set(key, '1', 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    } catch (err) {
      throw new IntradayRedisUnavailableError(`acquireIngestionIdempotencyLock(${key})`, err);
    }
  }

  /**
   * Best-effort cleanup, deliberately fail-*open* (logs, never throws) -
   * the one exception to this class's fail-visible rule. Called by
   * `IngestionService` when the idempotency lock was acquired but the
   * subsequent NATS publish failed: without releasing the lock, a
   * legitimate ACD/CCaaS retry of the same event would be silently treated
   * as a duplicate for the rest of the TTL window, which is exactly the
   * "looks fine but isn't" failure mode §6.1's spirit rules out. If the
   * release itself fails, the caller has already surfaced a 503 to the
   * retrying system - swallowing a second error here avoids masking the
   * first, real one.
   */
  async releaseIngestionIdempotencyLock(tenantId: string, sourceEventId: string): Promise<void> {
    const key = ingestionIdempotencyKey(tenantId, sourceEventId);
    try {
      await this.client.del(key);
    } catch (err) {
      this.logger.warn(
        `Failed to release idempotency lock ${key} after a downstream failure: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Phase 2 (§2.2 rule 2, ADR-0065): a plain `SET key 1 EX ttl`, no `NX` -
   * every schedule-published/assignment-changed event for this employee
   * refreshes (not just creates) the TTL, so an employee with an actively
   * changing schedule stays tracked, and one with no relevant event in the
   * TTL window self-prunes rather than requiring an explicit cleanup pass.
   */
  async trackEmployeeForScheduleSync(tenantId: string, employeeId: string, ttlSeconds: number): Promise<void> {
    const key = trackedEmployeeKey(tenantId, employeeId);
    try {
      await this.client.set(key, '1', 'EX', ttlSeconds);
    } catch (err) {
      throw new IntradayRedisUnavailableError(`trackEmployeeForScheduleSync(${key})`, err);
    }
  }

  /** `ShiftStartPreloadSchedulerService`'s per-tick input - bounded by whatever's currently tracked, not every employee platform-wide. */
  async listTrackedEmployees(): Promise<Array<{ tenantId: string; employeeId: string }>> {
    const results: Array<{ tenantId: string; employeeId: string }> = [];
    try {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await this.client.scan(cursor, 'MATCH', TRACKED_EMPLOYEE_SCAN_PATTERN, 'COUNT', 200);
        cursor = nextCursor;
        for (const key of keys) {
          const parsed = parseTrackedEmployeeKey(key);
          if (parsed) {
            results.push(parsed);
          }
        }
      } while (cursor !== '0');
      return results;
    } catch (err) {
      throw new IntradayRedisUnavailableError('listTrackedEmployees', err);
    }
  }

  /**
   * Phase 6: keeps `queueAgentsKey`'s reverse index in sync with
   * `AgentLiveState.queue_id` - pipelined `SREM` from the old queue's
   * membership set (if any) and `SADD` to the new one (if any), so
   * `ReallocationRecommendationService` can read real employee ids for a
   * queue rather than fabricating them. A no-op if the queue is unchanged.
   */
  async updateQueueMembership(
    tenantId: string,
    employeeId: string,
    previousQueueId: string | null,
    newQueueId: string | null,
  ): Promise<void> {
    if (previousQueueId === newQueueId) {
      return;
    }
    try {
      const pipeline = this.client.pipeline();
      if (previousQueueId) {
        pipeline.srem(queueAgentsKey(tenantId, previousQueueId), employeeId);
      }
      if (newQueueId) {
        pipeline.sadd(queueAgentsKey(tenantId, newQueueId), employeeId);
      }
      const results = await pipeline.exec();
      const failed = results?.find(([err]) => err);
      if (failed?.[0]) {
        throw failed[0];
      }
    } catch (err) {
      throw new IntradayRedisUnavailableError(`updateQueueMembership(${tenantId}, ${employeeId})`, err);
    }
  }

  /** `ReallocationRecommendationService`'s donor-candidate employee lookup - bounded by whatever's currently tracked, same honesty posture as `listTrackedEmployees`. */
  async listQueueMembers(tenantId: string, queueId: string): Promise<string[]> {
    const key = queueAgentsKey(tenantId, queueId);
    try {
      return await this.client.smembers(key);
    } catch (err) {
      throw new IntradayRedisUnavailableError(`listQueueMembers(${key})`, err);
    }
  }

  /** Same refresh-on-every-event shape as `trackEmployeeForScheduleSync` - a queue with no recent metrics update self-prunes out of reallocation-candidate consideration. */
  async trackQueueForReallocationScan(tenantId: string, queueId: string, ttlSeconds: number): Promise<void> {
    const key = trackedQueueKey(tenantId, queueId);
    try {
      await this.client.set(key, '1', 'EX', ttlSeconds);
    } catch (err) {
      throw new IntradayRedisUnavailableError(`trackQueueForReallocationScan(${key})`, err);
    }
  }

  /** `ReallocationRecommendationService`'s donor-search input - tenant-scoped (unlike `listTrackedEmployees`, which is cross-tenant for its own scheduler caller). */
  async listTrackedQueues(tenantId: string): Promise<string[]> {
    const results: string[] = [];
    try {
      let cursor = '0';
      const pattern = trackedQueueScanPattern(tenantId);
      do {
        const [nextCursor, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = nextCursor;
        for (const key of keys) {
          const parsed = parseTrackedQueueKey(key);
          if (parsed) {
            results.push(parsed.queueId);
          }
        }
      } while (cursor !== '0');
      return results;
    } catch (err) {
      throw new IntradayRedisUnavailableError(`listTrackedQueues(${tenantId})`, err);
    }
  }
}

/**
 * `HSET` for every non-null field, `HDEL` for every `null` one, in a single
 * pipeline - a Redis hash has no native `null`, and a naive "just omit the
 * field from HSET" would leave a stale value from a previous write lingering
 * (e.g. `scheduledActivity` going from a real value back to `null` on a
 * mid-shift schedule change, §2.2 rule 2 - Phase 2's problem to trigger, but
 * this phase's problem to make correct).
 */
async function writeHash(client: Redis, key: string, fields: Record<string, string | number | null>): Promise<void> {
  const toSet: Record<string, string> = {};
  const toDelete: string[] = [];
  for (const [field, value] of Object.entries(fields)) {
    if (value === null) {
      toDelete.push(field);
    } else {
      toSet[field] = String(value);
    }
  }
  const pipeline = client.pipeline();
  if (Object.keys(toSet).length > 0) {
    pipeline.hset(key, toSet);
  }
  if (toDelete.length > 0) {
    pipeline.hdel(key, ...toDelete);
  }
  const results = await pipeline.exec();
  const failed = results?.find(([err]) => err);
  if (failed?.[0]) {
    throw failed[0];
  }
}
