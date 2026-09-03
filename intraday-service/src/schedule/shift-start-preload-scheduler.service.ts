import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { IntradayRedisService } from '../redis/redis.service';
import { ScheduledActivityService } from './scheduled-activity.service';

/**
 * §2.2 rule 2's actual "at shift start" trigger. A schedule can be
 * published days before a shift begins - the `schedule.published`/
 * `assignment.changed` consumers only tell this service *which* employees
 * have a relevant upcoming/current shift (via `trackEmployeeForScheduleSync`'s
 * TTL marker); this tick is what actually flips `scheduled_activity` at
 * the right moment, by re-checking "is `now` inside a tracked employee's
 * shift" on a coarse, regular cadence.
 *
 * 1-minute cadence, finer than `src/modules/skill/services/skill-decay-scheduler.service.ts`'s
 * 15-minute cadence in the root app (shift-start timing precision matters
 * more here) - otherwise the exact same shape: tick → enumerate candidates
 * → per-candidate idempotent recheck → per-candidate try/catch isolation,
 * so one employee's transient failure never blocks the rest of the tick.
 */
@Injectable()
export class ShiftStartPreloadSchedulerService {
  private readonly logger = new Logger(ShiftStartPreloadSchedulerService.name);
  private ticking = false;

  constructor(
    private readonly redis: IntradayRedisService,
    private readonly scheduledActivity: ScheduledActivityService,
  ) {}

  @Cron('* * * * *')
  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await this.runOnce();
    } finally {
      this.ticking = false;
    }
  }

  private async runOnce(): Promise<void> {
    const tracked = await this.redis.listTrackedEmployees();
    for (const { tenantId, employeeId } of tracked) {
      try {
        await this.scheduledActivity.refresh(tenantId, employeeId);
      } catch (err) {
        this.logger.error(
          `Failed to refresh scheduled_activity for tenant ${tenantId} employee ${employeeId}: ${(err as Error).message}`,
        );
      }
    }
  }
}
