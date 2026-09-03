import { Provider } from '@nestjs/common';
import { PubSub } from 'graphql-subscriptions';

export const GRAPHQL_PUBSUB = Symbol('GRAPHQL_PUBSUB');

/**
 * In-process, single-instance PubSub (`graphql-subscriptions`), not
 * `graphql-redis-subscriptions` - same choice and same rationale as
 * intraday-service's own `pubsub.provider.ts` (this platform's only prior
 * GraphQL subscription surface): a distributed pub/sub backend would be
 * premature infrastructure ahead of any horizontal-scaling phase this
 * module has actually reached. `ClaimOpenShiftService` publishes into
 * this; the `marketplacePostUpdated` subscription resolver reads from it -
 * see `subscription-triggers.ts` for the shared trigger-name builder that
 * keeps the two sides in sync.
 */
export const pubSubProvider: Provider = {
  provide: GRAPHQL_PUBSUB,
  useValue: new PubSub(),
};
