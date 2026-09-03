import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DurableConsumerBinding } from '../nats/bind-durable-consumer';
import { DurableJetStreamConsumer } from '../nats/durable-jetstream-consumer.base';
import { IntradayNatsClientService } from '../nats/nats-client.service';
import { AssignmentChangedPayload, SCHEDULING_STREAM_NAME, SCHEDULING_SUBJECTS } from '../nats/subjects';
import { IntradayRedisService } from '../redis/redis.service';
import { ScheduledActivityService } from '../schedule/scheduled-activity.service';

const DEFAULT_TRACKED_EMPLOYEE_TTL_SECONDS = 48 * 60 * 60;

/**
 * §2.2 rule 2's "mid-shift schedule-change handling" - subscribes to
 * scheduling-service's `assignment.changed` event (ADR-0064, fired on a
 * manual override) and refreshes the affected employee's
 * `scheduled_activity` immediately, rather than waiting for
 * `ShiftStartPreloadSchedulerService`'s next tick. See ADR-0064's own
 * consequences section: `reoptimize_schedule` does not yet publish this
 * event, so a re-optimization-only reassignment still falls back to the
 * cron's own cadence.
 */
@Injectable()
export class AssignmentChangedConsumerService extends DurableJetStreamConsumer<AssignmentChangedPayload> {
  protected readonly logger = new Logger(AssignmentChangedConsumerService.name);

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
      durableName: 'intraday-assignment-changed',
      filterSubject: SCHEDULING_SUBJECTS.ASSIGNMENT_CHANGED,
    };
  }

  /** Public (widened from the base class's `protected abstract`) so unit tests can call it directly without a real `JsMsg`. */
  async handlePayload(payload: AssignmentChangedPayload): Promise<void> {
    const ttlSeconds = this.config.get<number>(
      'SCHEDULE_TRACKED_EMPLOYEE_TTL_SECONDS',
      DEFAULT_TRACKED_EMPLOYEE_TTL_SECONDS,
    );
    await this.redis.trackEmployeeForScheduleSync(payload.tenantId, payload.employeeId, ttlSeconds);
    await this.scheduledActivity.refresh(payload.tenantId, payload.employeeId);
  }
}
