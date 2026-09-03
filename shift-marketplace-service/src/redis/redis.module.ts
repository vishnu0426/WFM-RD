import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';
import { MarketplaceRedisService } from './redis.service';
import { MetricsModule } from '../common/metrics/metrics.module';

/**
 * ADR-0085: this module's Redis presence is exclusively the distributed
 * claim lock (§1's tech-stack table: "Redis is never the system of
 * record"), unlike intraday-service's Redis (which *is* the live-state
 * system of record, ADR-0062). `@Global()` for the same reason every other
 * service's Redis module is - every feature module that ever needs to
 * claim/swap/bid needs this without re-importing.
 */
@Global()
@Module({
  imports: [ConfigModule, MetricsModule],
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Redis =>
        new Redis({
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
          password: config.get<string>('REDIS_PASSWORD') || undefined,
          maxRetriesPerRequest: 2,
          lazyConnect: false,
        }),
    },
    MarketplaceRedisService,
  ],
  exports: [MarketplaceRedisService],
})
export class MarketplaceRedisModule {}
