import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { MetricsModule } from '../common/metrics/metrics.module';
import { RedisHeartbeatService } from './redis-heartbeat.service';
import { REDIS_CLIENT } from './redis.constants';
import { IntradayRedisService } from './redis.service';

/**
 * ADR-0062: this is a deliberate, independent copy of the root app's
 * `src/common/redis` module, not a shared import - the two have opposite
 * failure postures. Root's `RedisModule` backs a fail-open cache (§1 there:
 * "Redis is never a system of record"); here Redis holds
 * `AgentLiveState`/`QueueLiveState`, the live-state system of record for
 * *current* intraday state, so `IntradayRedisService` fails visibly instead
 * of silently swallowing errors. `@Global` for the same reason root's is -
 * every module in this service (ingestion now, the Phase 2 NATS consumer,
 * the Phase 4 live-read API) needs it without re-importing.
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
    IntradayRedisService,
    RedisHeartbeatService,
  ],
  exports: [IntradayRedisService],
})
export class IntradayRedisModule {}
