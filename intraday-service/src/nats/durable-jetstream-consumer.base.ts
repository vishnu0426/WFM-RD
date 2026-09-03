import { Logger } from '@nestjs/common';
import type { ConsumerMessages, JsMsg } from 'nats';
import { bindDurableConsumer, DurableConsumerBinding } from './bind-durable-consumer';
import { IntradayNatsClientService } from './nats-client.service';

/**
 * Shared lifecycle (start on boot, pull loop, poison-message handling,
 * nak-on-failure, drain on shutdown) for every durable JetStream consumer
 * this service runs. Phase 2 has three near-identical consumers
 * (`AgentStateChangedConsumerService`, `SchedulePublishedConsumerService`,
 * `AssignmentChangedConsumerService`) that differ only in *what* a message
 * means, never *how* one is pulled/acked/retried - factored out so a fix
 * to the shared mechanics (e.g. how a poison message is termed) lands
 * once, not three times independently drifting.
 *
 * `onModuleInit`/`onModuleDestroy` are NestJS lifecycle hooks - a subclass
 * decorated `@Injectable()` and registered as a provider gets these called
 * automatically by Nest, exactly like any other lifecycle-hook provider.
 */
export abstract class DurableJetStreamConsumer<TPayload> {
  protected abstract readonly logger: Logger;
  private messages: ConsumerMessages | null = null;
  private stopped = false;
  private loop: Promise<void> | null = null;

  protected constructor(private readonly natsClient: IntradayNatsClientService) {}

  protected abstract binding(): DurableConsumerBinding;
  protected abstract handlePayload(payload: TPayload): Promise<void>;

  async onModuleInit(): Promise<void> {
    // Started eagerly, unlike `IntradayNatsClientService.publish`'s
    // lazy-on-first-call connect - a subscriber has no "first call" to wait
    // for; it has to be actively pulling from boot.
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
    // Strictly sequential - one message fully handled (acked or nak'd)
    // before the next is pulled. For `AgentStateChangedConsumerService`
    // this is what trivially guarantees per-employee ordering (ADR-0063);
    // the other two consumers don't have an ordering requirement but share
    // this loop anyway, for one uniform mechanism.
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
