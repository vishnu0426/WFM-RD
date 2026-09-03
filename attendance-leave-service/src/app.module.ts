import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import databaseConfig from './database/typeorm.config';
import { TenantContextModule } from './common/tenant/tenant-context.module';
import { TenantContextMiddleware } from './common/tenant/tenant-context.middleware';
import { HealthModule } from './common/health/health.module';
import { MetricsModule } from './common/metrics/metrics.module';
import { HttpMetricsInterceptor } from './common/metrics/http-metrics.interceptor';
import { DomainErrorFilter } from './common/http/domain-error.filter';
import { AttendanceModule } from './attendance/attendance.module';
import { LeaveModule } from './leave/leave.module';
import { GrpcModule } from './grpc/grpc.module';

/**
 * Phase 1 (§7): the `attendance_leave` schema/role (ADR-0073) via
 * `agno_attendance_leave_app`, and the platform's standard
 * observability/tenant-context skeleton. Phase 2 added `AttendanceModule`
 * (badge/biometric ingestion, ADR-0075). Phase 3 added `LeaveModule`
 * (`requestLeave`, the conflict-check pipeline, ADR-0074/0076). Phase 4
 * added the BullMQ approval workflow (ADR-0077). Phase 5 adds `GrpcModule`
 * (`LeaveService.GetUnavailability`, ADR-0078) and this service's first
 * NATS publish. Phase 6 adds `submitBackdatedLeave` and this service's
 * first gRPC client (ADR-0079). Phase 7 adds `ScheduleModule.forRoot()`
 * (this service's first `@Cron` usage, mirroring core/intraday-service's
 * own convention) for `LeaveCarryoverJobService` (ADR-0080). No GraphQL
 * module - lands with whichever phase first needs it.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [databaseConfig] }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => config.getOrThrow('database'),
    }),
    ScheduleModule.forRoot(),
    TenantContextModule,
    AttendanceModule,
    LeaveModule,
    GrpcModule,
    HealthModule,
    MetricsModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: DomainErrorFilter },
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantContextMiddleware).forRoutes('*');
  }
}
