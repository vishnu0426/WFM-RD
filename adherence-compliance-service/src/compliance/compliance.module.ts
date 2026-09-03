import { Module } from '@nestjs/common';
import { MetricsModule } from '../common/metrics/metrics.module';
import { TenantContextModule } from '../common/tenant/tenant-context.module';
import { migratorPoolProvider } from '../database/migrator-pool.provider';
import { AuditGrpcClientModule } from '../grpc/audit-grpc-client.module';
import { CalendarGrpcClientModule } from '../grpc/calendar-grpc-client.module';
import { EmployeeGrpcClientModule } from '../grpc/employee-grpc-client.module';
import { ScheduleQueryGrpcClientModule } from '../grpc/schedule-query-grpc-client.module';
import { ComplianceRuleService } from './compliance-rule.service';
import { ComplianceRuleController } from './compliance-rule.controller';
import { RuleChangeImpactPreviewService } from './impact-preview/rule-change-impact-preview.service';
import { ComplianceReportService } from './reports/compliance-report.service';
import { ComplianceReportController } from './reports/compliance-report.controller';
import { RetentionPolicyService } from './reports/retention-policy.service';
import { RetentionPolicyController } from './reports/retention-policy.controller';
import { RetentionLifecycleJobService } from './reports/retention-lifecycle-job.service';
import { S3ReportStorageService } from './reports/s3-report-storage.service';
import { AuthModule } from '../auth/auth.module';

/**
 * Phase 2 (§7): `ComplianceRule` CRUD + citation enforcement. Phase 4 adds
 * the gRPC surface reusing `resolveEffectiveRules`/`ComplianceRuleService`.
 * Phase 5 (docs/adr/0104) adds `RuleChangeImpactPreview`'s real simulation
 * logic (`RuleChangeImpactPreviewService`) and the three gRPC clients it
 * and `activateRule`'s audit call depend on. Phase 6 (docs/adr/0105) adds
 * `generateComplianceReport` (`ComplianceReportService`/`Controller`,
 * `S3ReportStorageService`), reusing those same gRPC clients plus
 * `CalendarGrpcClientModule` for jurisdiction resolution. Phase 7
 * (docs/adr/0106) adds `RetentionLifecycleJobService` - its own
 * `migratorPoolProvider` registration (see that provider's own doc
 * comment for why this is a second pool, not a shared one with
 * `AdherenceModule`'s). Frontend gap-closing pass adds
 * `RetentionPolicyService`/`Controller` - the write path
 * `RetentionPolicy` never had (see that service's own doc comment).
 */
@Module({
  imports: [
    MetricsModule,
    TenantContextModule,
    AuditGrpcClientModule,
    CalendarGrpcClientModule,
    EmployeeGrpcClientModule,
    ScheduleQueryGrpcClientModule,
    AuthModule,
  ],
  controllers: [ComplianceRuleController, ComplianceReportController, RetentionPolicyController],
  providers: [
    ComplianceRuleService,
    RuleChangeImpactPreviewService,
    ComplianceReportService,
    RetentionPolicyService,
    S3ReportStorageService,
    migratorPoolProvider,
    RetentionLifecycleJobService,
  ],
  exports: [ComplianceRuleService, RuleChangeImpactPreviewService, ComplianceReportService, RetentionPolicyService],
})
export class ComplianceModule {}
