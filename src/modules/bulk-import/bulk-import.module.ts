import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BulkImportJob } from './entities/bulk-import-job.entity';
import { FeatureFlag } from './entities/feature-flag.entity';
import { BulkImportJobsRepository } from './repositories/bulk-import-jobs.repository';
import { FeatureFlagsRepository } from './repositories/feature-flags.repository';
import { FeatureFlagsService } from './services/feature-flags.service';
import { BulkImportService } from './services/bulk-import.service';
import { BulkImportController } from './rest/bulk-import.controller';
import { FeatureFlagResolver } from './graphql/feature-flag.resolver';
import { EmployeeModule } from '../employee/employee.module';
import { OrgUnitModule } from '../org-unit/org-unit.module';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { PlatformSettingsModule } from '../platform-settings/platform-settings.module';

/**
 * Imports `EmployeeModule` (writes) and `OrgUnitModule` (validation) - both
 * one-directional, neither imports this module back. `AuthModule` added
 * (frontend Phase 1 prerequisite, for gating the highest-blast-radius
 * write surface in this module) - no cycle risk.
 *
 * `AuditModule` added for GAP-06 (enterprise readiness audit, 2026-08-18):
 * `BulkImportService` now injects `AuditLogRepository` directly - no cycle
 * risk, same as every other module's own addition.
 *
 * Platform Settings gap-fix: `PlatformSettingsModule` added for
 * `FeatureFlagsService`'s new platform-wide-default fallback. Harmless
 * diamond with the `AuthModule -> TenantSettingsModule -> PlatformSettingsModule`
 * path above (both converge on the same leaf module) - not a cycle, since
 * `PlatformSettingsModule` doesn't import this module back.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([BulkImportJob, FeatureFlag]),
    EmployeeModule,
    OrgUnitModule,
    AuthModule,
    AuditModule,
    PlatformSettingsModule,
  ],
  providers: [
    BulkImportJobsRepository,
    FeatureFlagsRepository,
    FeatureFlagsService,
    BulkImportService,
    FeatureFlagResolver,
  ],
  controllers: [BulkImportController],
  exports: [TypeOrmModule, BulkImportJobsRepository, FeatureFlagsRepository, FeatureFlagsService],
})
export class BulkImportModule {}
