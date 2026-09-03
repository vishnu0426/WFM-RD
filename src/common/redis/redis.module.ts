import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';
import { RedisService } from './redis.service';

/**
 * §1: Redis is session/token cache, distributed locks, and rate limiting
 * only - never a system of record. `@Global` so `RedisService` doesn't need
 * re-importing into every module that needs the cache (`AuthModule`, and the
 * gRPC `IdentityGrpcController`'s `UserContextCacheService`), mirroring how
 * `TenantContextModule` is wired.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Redis =>
        new Redis({
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
          password: config.get<string>('REDIS_PASSWORD') || undefined,
          // Fail fast rather than buffering commands indefinitely against a
          // down Redis - callers (UserContextCacheService, RefreshTokenService)
          // are written to treat a Redis error as a cache-miss/fall through
          // to Postgres, never as a hard dependency.
          maxRetriesPerRequest: 2,
          lazyConnect: false,
        }),
    },
    RedisService,
  ],
  exports: [RedisService],
})
export class RedisModule {}
