import { Module } from '@nestjs/common';
import { MarketplaceNatsClientService } from './nats-client.service';
import { MetricsModule } from '../common/metrics/metrics.module';

@Module({
  imports: [MetricsModule],
  providers: [MarketplaceNatsClientService],
  exports: [MarketplaceNatsClientService],
})
export class MarketplaceNatsModule {}
