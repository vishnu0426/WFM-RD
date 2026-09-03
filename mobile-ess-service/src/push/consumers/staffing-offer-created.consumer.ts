import { Injectable, Logger } from '@nestjs/common';
import { DurableConsumerBinding } from '../../nats/bind-durable-consumer';
import { DurableJetStreamConsumer } from '../../nats/durable-jetstream-consumer.base';
import { MobileEssNatsClientService } from '../../nats/nats-client.service';
import { INTRADAY_STREAM_NAME, INTRADAY_SUBJECTS, StaffingOfferCreatedPayload } from '../../nats/subjects';
import { PushDispatchService } from '../push-dispatch.service';

/**
 * Subscribes to intraday-service's own stream (already provisioned,
 * `scripts/provision-nats-streams.ts`) - a cross-service subscription, not
 * one of this service's own published subjects, same relationship
 * `LeaveRequestApprovedConsumerService` has to attendance-leave-service's
 * stream.
 */
@Injectable()
export class StaffingOfferCreatedConsumerService extends DurableJetStreamConsumer<StaffingOfferCreatedPayload> {
  protected readonly logger = new Logger(StaffingOfferCreatedConsumerService.name);

  constructor(
    natsClient: MobileEssNatsClientService,
    private readonly pushDispatch: PushDispatchService,
  ) {
    super(natsClient);
  }

  protected binding(): DurableConsumerBinding {
    return {
      stream: INTRADAY_STREAM_NAME,
      durableName: 'mobile-ess-staffing-offer-created',
      filterSubject: INTRADAY_SUBJECTS.STAFFING_OFFER_CREATED,
    };
  }

  /** Public (widened from the base class's `protected abstract`) so unit
   * tests can call it directly without a real `JsMsg` - same convention
   * `LeaveRequestApprovedConsumerService` uses. */
  async handlePayload(payload: StaffingOfferCreatedPayload): Promise<void> {
    await this.pushDispatch.dispatchStaffingOfferCreated(payload);
  }
}
