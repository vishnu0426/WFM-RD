import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LeaveRequestController } from './leave-request.controller';
import { LeaveRequestService } from './leave-request.service';
import { LeaveConflictCheckService } from './leave-conflict-check.service';
import { DecideLeaveRequestController } from './decide-leave-request.controller';
import { DecideLeaveRequestService } from './decide-leave-request.service';
import { LeaveApprovalQueueService } from './bullmq/leave-approval-queue.service';
import { LeaveApprovalReminderWorker } from './bullmq/leave-approval-reminder.worker';
import { SchedulingClientModule } from '../common/scheduling/scheduling-client.module';
import { MetricsModule } from '../common/metrics/metrics.module';
import { TenantContextModule } from '../common/tenant/tenant-context.module';
import { AttendanceLeaveNatsModule } from '../nats/nats.module';
import { AuditGrpcClientModule } from '../grpc/audit-grpc-client.module';
import { CalendarGrpcClientModule } from '../grpc/calendar-grpc-client.module';
import { migratorPoolProvider } from '../database/migrator-pool.provider';
import { LeaveCarryoverJobService } from './carryover/leave-carryover-job.service';
import { AbsencePatternController } from './absence-pattern/absence-pattern.controller';
import { AbsencePatternDetectionJob } from './absence-pattern/absence-pattern-detection.job';
import { AcknowledgeAbsencePatternService } from './absence-pattern/acknowledge-absence-pattern.service';
import { ListAbsencePatternsService } from './absence-pattern/list-absence-patterns.service';
import { EmployeeLeaveBalanceController } from './employee-leave-balance.controller';
import { ListEmployeeLeaveBalancesService } from './list-employee-leave-balances.service';
import { ProvisionLeaveBalanceService } from './provision-leave-balance.service';
import { ListLeaveRequestsService } from './list-leave-requests.service';
import { LeaveTypeController } from './leave-type.controller';
import { LeaveTypeService } from './leave-type.service';
import { AccrualPolicyController } from './accrual-policy.controller';
import { AccrualPolicyService } from './accrual-policy.service';
import { LeaveAccrualJobService } from './carryover/leave-accrual-job.service';
import { AuthModule } from '../auth/auth.module';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { TenantTokenMatchGuard } from '../auth/tenant-token-match.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { EmployeeGrpcClientModule } from '../grpc/employee-grpc-client.module';

// No `TypeOrmModule.forFeature(...)` - same reasoning as `AttendanceModule`
// (RLS requires the per-request `app.current_tenant_id` GUC via
// `withTenantConnection`/`DataSource`, which a plain `@InjectRepository`
// never sets). `LeaveCarryoverJobService`/`AbsencePatternDetectionJob` are
// the exceptions - both use `migratorPoolProvider` directly (cross-tenant
// by nature, see that provider's own doc comment), not
// `DataSource`/`withTenantConnection`.
@Module({
  imports: [
    ConfigModule,
    SchedulingClientModule,
    MetricsModule,
    TenantContextModule,
    AttendanceLeaveNatsModule,
    AuditGrpcClientModule,
    CalendarGrpcClientModule,
    AuthModule,
    EmployeeGrpcClientModule,
  ],
  controllers: [
    LeaveRequestController,
    DecideLeaveRequestController,
    AbsencePatternController,
    EmployeeLeaveBalanceController,
    LeaveTypeController,
    AccrualPolicyController,
  ],
  providers: [
    LeaveRequestService,
    LeaveConflictCheckService,
    DecideLeaveRequestService,
    LeaveApprovalQueueService,
    LeaveApprovalReminderWorker,
    migratorPoolProvider,
    LeaveCarryoverJobService,
    AbsencePatternDetectionJob,
    AcknowledgeAbsencePatternService,
    ListAbsencePatternsService,
    ListEmployeeLeaveBalancesService,
    ProvisionLeaveBalanceService,
    ListLeaveRequestsService,
    LeaveTypeService,
    AccrualPolicyService,
    LeaveAccrualJobService,
    AccessTokenGuard,
    TenantTokenMatchGuard,
    PermissionsGuard,
  ],
})
export class LeaveModule {}
