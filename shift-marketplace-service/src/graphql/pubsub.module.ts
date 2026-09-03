import { Global, Module } from '@nestjs/common';
import { pubSubProvider } from './pubsub.provider';

/** `@Global()` - shared by the claim/swap/bid services (publish side) and the marketplace resolver (subscribe side), which otherwise have no reason to import each other's modules. */
@Global()
@Module({
  providers: [pubSubProvider],
  exports: [pubSubProvider],
})
export class GraphQLPubSubModule {}
