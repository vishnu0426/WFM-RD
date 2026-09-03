import { Global, Module } from '@nestjs/common';
import { IntradayNatsClientService } from './nats-client.service';

/** `@Global` so `IngestionService` (and every future publisher in this service) can inject it without re-importing. */
@Global()
@Module({
  providers: [IntradayNatsClientService],
  exports: [IntradayNatsClientService],
})
export class IntradayNatsModule {}
