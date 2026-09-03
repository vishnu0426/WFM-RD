import { Provider } from '@nestjs/common';
import { PubSub } from 'graphql-subscriptions';

export const GRAPHQL_PUBSUB = Symbol('GRAPHQL_PUBSUB');

/**
 * Phase 4 (design doc assumption 2): in-process, single-instance PubSub
 * (`graphql-subscriptions`), not `graphql-redis-subscriptions`. This
 * service's existing ordering/consumer-guarantee scope already assumes a
 * single running instance (ADR-0063/ADR-0065's own stated boundary) - a
 * distributed pub/sub backend would be premature infrastructure ahead of
 * that same Phase 7 horizontal-scaling work, not a separate problem to
 * solve now. `QueueMetricsUpdatedConsumerService` publishes into this;
 * the `queueLiveStateUpdated` GraphQL subscription resolver reads from it
 * - see `subscription-triggers.ts` for the shared trigger-name builder
 * that keeps the two sides in sync.
 */
export const pubSubProvider: Provider = {
  provide: GRAPHQL_PUBSUB,
  useValue: new PubSub(),
};
