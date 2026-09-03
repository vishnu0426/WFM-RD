import { Injectable } from '@nestjs/common';
import { IntradayRedisService } from '../redis/redis.service';

/**
 * The one real, honest side effect a reallocation "execution" can perform
 * in this service: move each affected employee's `AgentLiveState.queue_id`
 * in Redis (which also keeps `queueAgentsKey`'s reverse index correct via
 * `updateQueueMembership`). Explicitly does **not** integrate with any
 * real ACD/telephony call-routing system - no such integration exists
 * anywhere in this repo, the same class of honest gap as Phase 5's
 * escalation having no real notification fan-out (ADR-0069). Shared by
 * both `ReallocationRecommendationService`'s auto-execute branch and
 * `ReallocationApprovalService`'s manual approval path so the one real
 * effect is defined once, not duplicated.
 */
@Injectable()
export class ReallocationExecutionService {
  constructor(private readonly redis: IntradayRedisService) {}

  async applyReallocation(
    tenantId: string,
    fromQueueId: string,
    toQueueId: string,
    affectedEmployeeIds: string[],
  ): Promise<void> {
    for (const employeeId of affectedEmployeeIds) {
      await this.redis.writeAgentLiveState(tenantId, employeeId, { queueId: toQueueId });
      await this.redis.updateQueueMembership(tenantId, employeeId, fromQueueId, toQueueId);
    }
  }
}
