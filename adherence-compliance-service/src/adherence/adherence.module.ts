import { Module } from '@nestjs/common';
import { MetricsModule } from '../common/metrics/metrics.module';
import { migratorPoolProvider } from '../database/migrator-pool.provider';
import { EmployeeGrpcClientModule } from '../grpc/employee-grpc-client.module';
import { CalendarGrpcClientModule } from '../grpc/calendar-grpc-client.module';
import { TimezoneResolverService } from './timezone-resolver.service';
import { AdherenceDailyRollupJobService } from './adherence-daily-rollup-job.service';
import { AdherenceWeeklyMonthlyRollupJobService } from './adherence-weekly-monthly-rollup-job.service';
import { AdherenceRollupService } from './adherence-rollup.service';
import { EmployeeAdherenceScoreQueryService } from './employee-adherence-score-query.service';

/**
 * §7 Phase 3 (ADR-0098): this module's first `@Cron` jobs. Phase 3/ADR-0099:
 * `EmployeeGrpcClientModule`/`CalendarGrpcClientModule` (this service's
 * first gRPC clients of any kind) + `TimezoneResolverService`, so both jobs
 * bucket by each employee's own real timezone rather than a UTC assumption.
 * Module 10 Phase 4 (docs/adr/0121) adds `AdherenceRollupService` - the
 * first thing that reads `AdherenceScore` back out through this module's
 * own API, via `AdherenceRollupGrpcController` (`grpc/grpc.module.ts`).
 * Module 11 Phase 7 (docs/adr/0156) adds `EmployeeAdherenceScoreQueryService` -
 * the first single-employee (not roster-aggregate) read, exposed via
 * `AdherenceScoreResolver` (`graphql/graphql.module.ts`).
 */
@Module({
  imports: [MetricsModule, EmployeeGrpcClientModule, CalendarGrpcClientModule],
  providers: [
    migratorPoolProvider,
    TimezoneResolverService,
    AdherenceDailyRollupJobService,
    AdherenceWeeklyMonthlyRollupJobService,
    AdherenceRollupService,
    EmployeeAdherenceScoreQueryService,
  ],
  exports: [AdherenceRollupService, EmployeeAdherenceScoreQueryService],
})
export class AdherenceModule {}
