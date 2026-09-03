import { Global, Module } from '@nestjs/common';
import { IntegrationHubNatsClientService } from './integration-hub-nats-client.service';

/** `@Global` so any future publisher in this service can inject it without re-importing - own copy of `IntradayNatsModule`'s own doc comment. */
@Global()
@Module({
  providers: [IntegrationHubNatsClientService],
  exports: [IntegrationHubNatsClientService],
})
export class IntegrationHubNatsModule {}
