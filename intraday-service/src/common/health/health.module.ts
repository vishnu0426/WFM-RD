import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/**
 * `IntradayRedisService` is already globally injectable (`@Global()
 * IntradayRedisModule`); `DataSource` is too (TypeOrmModule.forRootAsync's
 * own internal `TypeOrmCoreModule` is `@Global()`, same as the root app's
 * `HealthController` relies on); `ConfigService` is too
 * (`ConfigModule.forRoot({ isGlobal: true })`, `app.module.ts`) - no
 * `imports` needed here.
 */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
