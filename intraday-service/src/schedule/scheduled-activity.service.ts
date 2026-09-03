import { Injectable } from '@nestjs/common';
import { IntradayRedisService } from '../redis/redis.service';
import { ScheduleServiceClient } from './schedule-service-client';

export const ON_SHIFT_ACTIVITY = 'on_shift';

/**
 * §2.2 rule 2 / ADR-0065: derives `AgentLiveState.scheduled_activity` as a
 * coarse `"on_shift"`/`null` signal, not a rich per-queue/per-activity
 * value - `ShiftAssignment` (scheduling-service's schema) carries only
 * `shift_start`/`shift_end`/`skill_id`, no activity-code field (ADR-0064's
 * consequences section). Writes only the `scheduledActivity` field, via
 * `IntradayRedisService`'s partial-write support - never touches
 * `currentActivity`/etc., which `AgentStateChangedConsumerService` owns
 * independently.
 */
@Injectable()
export class ScheduledActivityService {
  constructor(
    private readonly client: ScheduleServiceClient,
    private readonly redis: IntradayRedisService,
  ) {}

  /**
   * `windowStart === windowEnd === now`: scheduling-service's endpoint
   * filters `shift_start < to AND shift_end > from`, so a zero-width
   * window at `now` is exactly "does any published assignment's
   * half-open `[shift_start, shift_end)` cover this instant" - no
   * client-side re-filtering needed, and no arbitrary lookahead/lookbehind
   * padding to justify.
   */
  async refresh(tenantId: string, employeeId: string): Promise<void> {
    const now = new Date();
    const assignments = await this.client.getShiftAssignments(tenantId, employeeId, now, now);
    await this.redis.writeAgentLiveState(tenantId, employeeId, {
      scheduledActivity: assignments.length > 0 ? ON_SHIFT_ACTIVITY : null,
    });
  }
}
