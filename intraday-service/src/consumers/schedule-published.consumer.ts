import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DurableConsumerBinding } from '../nats/bind-durable-consumer';
import { DurableJetStreamConsumer } from '../nats/durable-jetstream-consumer.base';
import { IntradayNatsClientService } from '../nats/nats-client.service';
import { SCHEDULING_STREAM_NAME, SCHEDULING_SUBJECTS, SchedulePublishedPayload } from '../nats/subjects';
import { IntradayRedisService } from '../redis/redis.service';
import { ScheduledActivityService } from '../schedule/scheduled-activity.service';

const DEFAULT_TRACKED_EMPLOYEE_TTL_SECONDS = 48 * 60 * 60;

/**
 * §2.2 rule 2 / ADR-0065: subscribes to scheduling-service's own stream
 * (ADR-0064) - a cross-service subscription, not one of this service's own
 * published subjects. On a `schedule.published` event: marks every named
 * employee as tracked (so `ShiftStartPreloadSchedulerService`'s cron picks
 * them up at their actual shift-start moment, per §2.2 rule 2's "triggered
 * off `published_at` combined with the employee's actual shift start
 * time"), and refreshes immediately once (covers a schedule published for
 * a shift already underway - no reason to wait for the next tick).
 */
@Injectable()
export class SchedulePublishedConsumerService extends DurableJetStreamConsumer<SchedulePublishedPayload> {
  protected readonly logger = new Logger(SchedulePublishedConsumerService.name);

  constructor(
    natsClient: IntradayNatsClientService,
    private readonly redis: IntradayRedisService,
    private readonly scheduledActivity: ScheduledActivityService,
    private readonly config: ConfigService,
  ) {
    super(natsClient);
  }

  protected binding(): DurableConsumerBinding {
    return {
      stream: SCHEDULING_STREAM_NAME,
      durableName: 'intraday-schedule-published',
      filterSubject: SCHEDULING_SUBJECTS.SCHEDULE_PUBLISHED,
    };
  }

  /** Public (widened from the base class's `protected abstract`) so unit tests can call it directly without a real `JsMsg`. */
  async handlePayload(payload: SchedulePublishedPayload): Promise<void> {
    const ttlSeconds = this.config.get<number>(
      'SCHEDULE_TRACKED_EMPLOYEE_TTL_SECONDS',
      DEFAULT_TRACKED_EMPLOYEE_TTL_SECONDS,
    );
    for (const employeeId of payload.employeeIds) {
      await this.redis.trackEmployeeForScheduleSync(payload.tenantId, employeeId, ttlSeconds);
      await this.scheduledActivity.refresh(payload.tenantId, employeeId);
    }
  }
}
