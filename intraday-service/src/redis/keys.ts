/**
 * §2.1's Redis key schema. Kept as plain functions (not a class) so both
 * `IntradayRedisService` and unit tests build the exact same key string
 * without going through a live Redis connection.
 */

export function agentLiveStateKey(tenantId: string, employeeId: string): string {
  return `tenant:${tenantId}:agent:${employeeId}`;
}

export function queueLiveStateKey(tenantId: string, queueId: string): string {
  return `tenant:${tenantId}:queue:${queueId}`;
}

/**
 * §4.2: dedup key for the webhook ingestion idempotency lock, keyed on the
 * ACD/CCaaS system's own event id, not a client-supplied `Idempotency-Key`
 * header (there is no client in the browser sense here - the caller is a
 * server-to-server webhook).
 */
export function ingestionIdempotencyKey(tenantId: string, sourceEventId: string): string {
  return `tenant:${tenantId}:intraday:ingested-event:${sourceEventId}`;
}

/**
 * Phase 2 (§2.2 rule 2, ADR-0065): a TTL-pruned marker meaning "this
 * employee has a known upcoming/current published shift, worth checking on
 * `ShiftStartPreloadSchedulerService`'s next tick." Not a queue of work
 * items - just a bounded set `ShiftStartPreloadSchedulerService` `SCAN`s,
 * so tracking is self-pruning (an employee with no shift in the trailing/
 * leading TTL window naturally drops out) rather than growing unbounded
 * across a tenant's whole roster.
 */
export function trackedEmployeeKey(tenantId: string, employeeId: string): string {
  return `tenant:${tenantId}:intraday:tracked-employee:${employeeId}`;
}

export const TRACKED_EMPLOYEE_SCAN_PATTERN = 'tenant:*:intraday:tracked-employee:*';

/** Parses `{tenantId, employeeId}` back out of a key matching `TRACKED_EMPLOYEE_SCAN_PATTERN`. */
export function parseTrackedEmployeeKey(key: string): { tenantId: string; employeeId: string } | null {
  const match = /^tenant:(.+):intraday:tracked-employee:(.+)$/.exec(key);
  if (!match) {
    return null;
  }
  return { tenantId: match[1], employeeId: match[2] };
}

/**
 * Phase 6: reverse index of `AgentLiveState.queue_id` - a Redis SET of
 * employee ids currently in this queue, so `ReallocationRecommendationService`
 * can answer "which employees are in queue X" without a fabricated guess.
 * Maintained by `AgentStateChangedConsumerService` (see its own doc comment).
 */
export function queueAgentsKey(tenantId: string, queueId: string): string {
  return `tenant:${tenantId}:intraday:queue-agents:${queueId}`;
}

/**
 * Phase 6: same TTL'd, self-pruning shape as `trackedEmployeeKey` - "this
 * queue had a `queue.metrics_updated` event recently, worth checking as a
 * reallocation donor/target candidate," refreshed on every metrics update
 * rather than requiring an unbounded tenant-wide queue registry.
 */
export function trackedQueueKey(tenantId: string, queueId: string): string {
  return `tenant:${tenantId}:intraday:tracked-queue:${queueId}`;
}

export const TRACKED_QUEUE_SCAN_PATTERN_PREFIX = 'tenant:';
export const TRACKED_QUEUE_SCAN_PATTERN_SUFFIX = ':intraday:tracked-queue:*';

/** Tenant-scoped SCAN pattern - `listTrackedQueues` only ever needs one tenant's queues, not a cross-tenant scan. */
export function trackedQueueScanPattern(tenantId: string): string {
  return `${TRACKED_QUEUE_SCAN_PATTERN_PREFIX}${tenantId}${TRACKED_QUEUE_SCAN_PATTERN_SUFFIX}`;
}

/** Parses `queueId` back out of a key matching `trackedQueueScanPattern(tenantId)`. */
export function parseTrackedQueueKey(key: string): { queueId: string } | null {
  const match = /^tenant:.+:intraday:tracked-queue:(.+)$/.exec(key);
  if (!match) {
    return null;
  }
  return { queueId: match[1] };
}
