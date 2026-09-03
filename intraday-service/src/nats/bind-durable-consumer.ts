import { AckPolicy, DeliverPolicy, type ConsumerMessages } from 'nats';
import { IntradayNatsClientService } from './nats-client.service';

export interface DurableConsumerBinding {
  stream: string;
  durableName: string;
  filterSubject: string;
}

/**
 * Shared setup for every durable JetStream consumer this service binds
 * (`AgentStateChangedConsumerService`, `SchedulePublishedConsumerService`,
 * `AssignmentChangedConsumerService`, Phase 2) - three identical,
 * non-trivial setup blocks (idempotent consumer provisioning +
 * `consumers.get`/`.consume()`) justify one shared helper here, unlike a
 * "three similar lines" case this platform's own non-negotiables warn
 * against abstracting prematurely.
 *
 * `ack_policy: Explicit` + `deliver_policy: All`: every message must be
 * individually acked (no implicit/none-policy auto-ack that could lose a
 * message this service crashed before processing), and a fresh durable
 * consumer starts from the stream's oldest retained message rather than
 * only new ones - a consumer created after some events already landed
 * still catches up on all of them, not just future ones.
 */
export async function bindDurableConsumer(
  natsClient: IntradayNatsClientService,
  binding: DurableConsumerBinding,
): Promise<ConsumerMessages> {
  const conn = await natsClient.getConnection();
  const jsm = await conn.jetstreamManager();
  try {
    await jsm.consumers.info(binding.stream, binding.durableName);
  } catch {
    // `consumers.info` throws "consumer not found" when it doesn't exist
    // yet - same info-throws/add-creates idiom
    // `scripts/provision-nats-streams.ts` already uses for streams.
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
