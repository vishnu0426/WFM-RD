import { Logger } from '@nestjs/common';
import type { ConsumerMessages, JsMsg } from 'nats';
import { bindDurableConsumer, DurableConsumerBinding } from './bind-durable-consumer';
import { MobileEssNatsClientService } from './nats-client.service';

/**
 * Direct copy of `intraday-service`'s own `DurableJetStreamConsumer`
 * (ADR-0154) - shared pull/ack/nak/poison-message lifecycle for every
 * durable JetStream consumer this service runs. This service only has one
 * consumer this phase (`LeaveRequestApprovedConsumerService`), but the
 * base class is copied rather than inlined so a second future consumer
 * (e.g. a marketplace event, explicitly out of scope this phase) doesn't
 * have to duplicate this mechanics from scratch.
 */
export abstract class DurableJetStreamConsumer<TPayload> {
  protected abstract readonly logger: Logger;
  private messages: ConsumerMessages | null = null;
  private stopped = false;
  private loop: Promise<void> | null = null;

  protected constructor(private readonly natsClient: MobileEssNatsClientService) {}

  protected abstract binding(): DurableConsumerBinding;
  protected abstract handlePayload(payload: TPayload): Promise<void>;

  async onModuleInit(): Promise<void> {
    this.loop = this.run().catch((err) => {
      this.logger.error(`consumer loop exited unexpectedly: ${(err as Error).message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    await this.messages?.close();
    await this.loop;
  }

  private async run(): Promise<void> {
    this.messages = await bindDurableConsumer(this.natsClient, this.binding());
    for await (const msg of this.messages) {
      if (this.stopped) {
        break;
      }
      await this.handle(msg);
    }
  }

  private async handle(msg: JsMsg): Promise<void> {
    let payload: TPayload;
    try {
      payload = msg.json<TPayload>();
    } catch (err) {
      this.logger.error(
        `Poison message on ${msg.subject} (seq ${msg.seq}) - terminating, not redelivering: ${(err as Error).message}`,
      );
      msg.term('unparseable payload');
      return;
    }
    try {
      await this.handlePayload(payload);
      msg.ack();
    } catch (err) {
      this.logger.warn(
        `Failed to process message on ${msg.subject} (seq ${msg.seq}), nak'ing for redelivery: ${(err as Error).message}`,
      );
      msg.nak();
    }
  }
}
