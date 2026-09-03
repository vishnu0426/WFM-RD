import { AckPolicy, DeliverPolicy, type ConsumerMessages } from 'nats';
import { MobileEssNatsClientService } from './nats-client.service';

export interface DurableConsumerBinding {
  stream: string;
  durableName: string;
  filterSubject: string;
}

/**
 * Direct copy of `intraday-service`'s own `bind-durable-consumer.ts`
 * (ADR-0154). `ack_policy: Explicit` + `deliver_policy: All`: every
 * message must be individually acked, and a fresh durable consumer starts
 * from the stream's oldest retained message rather than only new ones.
 */
export async function bindDurableConsumer(
  natsClient: MobileEssNatsClientService,
  binding: DurableConsumerBinding,
): Promise<ConsumerMessages> {
  const conn = await natsClient.getConnection();
  const jsm = await conn.jetstreamManager();
  try {
    await jsm.consumers.info(binding.stream, binding.durableName);
  } catch {
    // `consumers.info` throws "consumer not found" when it doesn't exist
    // yet - same info-throws/add-creates idiom `scripts/provision-nats-streams.ts`
    // already uses for streams.
    await jsm.consumers.add(binding.stream, {
      durable_name: binding.durableName,
      filter_subject: binding.filterSubject,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
    });
  }
  const js = conn.jetstream();
  const consumer = await js.consumers.get(binding.stream, binding.durableName);
  return consumer.consume();
}
