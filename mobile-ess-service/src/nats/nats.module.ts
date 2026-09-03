import { Global, Module } from '@nestjs/common';
import { MobileEssNatsClientService } from './nats-client.service';

/** `@Global` so `LeaveRequestApprovedConsumerService` (and any future
 * consumer/publisher in this service) can inject it without re-importing. */
@Global()
@Module({
  providers: [MobileEssNatsClientService],
  exports: [MobileEssNatsClientService],
})
export class MobileEssNatsModule {}
