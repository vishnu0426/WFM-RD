import { Global, Module } from '@nestjs/common';
import { pubSubProvider } from './pubsub.provider';

/** `@Global()` - shared by `QueueMetricsUpdatedConsumerService` (`src/consumers/`, the publish side) and `QueueLiveStateResolver` (the subscribe side), which otherwise have no reason to import each other's modules. */
@Global()
@Module({
  providers: [pubSubProvider],
  exports: [pubSubProvider],
})
export class GraphQLPubSubModule {}
