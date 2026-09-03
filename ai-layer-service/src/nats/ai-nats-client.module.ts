import { Module } from '@nestjs/common';
import { AiNatsClientService } from './ai-nats-client.service';

@Module({
  providers: [AiNatsClientService],
  exports: [AiNatsClientService],
})
export class AiNatsClientModule {}
