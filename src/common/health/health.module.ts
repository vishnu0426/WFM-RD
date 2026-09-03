import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/**
 * `DataSource` (from `TypeOrmModule.forRootAsync` in `app.module.ts`) and
 * `RedisService` (`@Global() RedisModule`) are both already globally
 * injectable - no `imports` needed here.
 */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
