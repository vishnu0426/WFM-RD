import { Injectable, Logger } from '@nestjs/common';
import { DurableConsumerBinding } from '../../nats/bind-durable-consumer';
import { DurableJetStreamConsumer } from '../../nats/durable-jetstream-consumer.base';
import { MobileEssNatsClientService } from '../../nats/nats-client.service';
import {
  ATTENDANCE_LEAVE_STREAM_NAME,
  ATTENDANCE_LEAVE_SUBJECTS,
  LeaveRequestApprovedPayload,
} from '../../nats/subjects';
import { PushDispatchService } from '../push-dispatch.service';

/**
 * ADR-0154 §B. Subscribes to attendance-leave-service's own stream
 * (already provisioned, `scripts/provision-nats-streams.ts`) - a
 * cross-service subscription, not one of this service's own published
 * subjects, same relationship `SchedulePublishedConsumerService` has to
 * scheduling-service's stream.
 */
@Injectable()
export class LeaveRequestApprovedConsumerService extends DurableJetStreamConsumer<LeaveRequestApprovedPayload> {
  protected readonly logger = new Logger(LeaveRequestApprovedConsumerService.name);

  constructor(
    natsClient: MobileEssNatsClientService,
    private readonly pushDispatch: PushDispatchService,
  ) {
    super(natsClient);
  }

  protected binding(): DurableConsumerBinding {
    return {
      stream: ATTENDANCE_LEAVE_STREAM_NAME,
      durableName: 'mobile-ess-leave-request-approved',
      filterSubject: ATTENDANCE_LEAVE_SUBJECTS.LEAVE_REQUEST_APPROVED,
    };
  }

  /** Public (widened from the base class's `protected abstract`) so unit
   * tests can call it directly without a real `JsMsg` - same convention
   * `SchedulePublishedConsumerService` uses. */
  async handlePayload(payload: LeaveRequestApprovedPayload): Promise<void> {
    await this.pushDispatch.dispatchLeaveApproved(payload);
  }
}
