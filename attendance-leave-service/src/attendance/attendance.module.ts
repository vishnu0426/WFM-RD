import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AttendanceIngestionController } from './attendance-ingestion.controller';
import { AttendanceIngestionService } from './attendance-ingestion.service';
import { AttendanceExceptionDetectionService } from './attendance-exception-detection.service';
import { HmacSignatureGuard } from './hmac-signature.guard';
import { EmployeeAttendanceRecordController } from './employee-attendance-record.controller';
import { ListEmployeeAttendanceRecordsService } from './list-employee-attendance-records.service';
import { AttendanceExceptionController } from './attendance-exception.controller';
import { ListAttendanceExceptionsService } from './list-attendance-exceptions.service';
import { SchedulingClientModule } from '../common/scheduling/scheduling-client.module';
import { MetricsModule } from '../common/metrics/metrics.module';
import { TenantContextModule } from '../common/tenant/tenant-context.module';
import { AuthModule } from '../auth/auth.module';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { TenantTokenMatchGuard } from '../auth/tenant-token-match.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { EmployeeGrpcClientModule } from '../grpc/employee-grpc-client.module';

// No `TypeOrmModule.forFeature(...)` here - `AttendanceIngestionService`
// goes through `withTenantConnection`/`DataSource` directly (RLS requires
// the per-request `app.current_tenant_id` GUC, which a plain injected
// `Repository` never sets), not the standard `@InjectRepository` pattern.
@Module({
  imports: [
    ConfigModule,
    SchedulingClientModule,
    MetricsModule,
    TenantContextModule,
    AuthModule,
    EmployeeGrpcClientModule,
  ],
  controllers: [AttendanceIngestionController, EmployeeAttendanceRecordController, AttendanceExceptionController],
  providers: [
    AttendanceIngestionService,
    AttendanceExceptionDetectionService,
    HmacSignatureGuard,
    ListEmployeeAttendanceRecordsService,
    ListAttendanceExceptionsService,
    AccessTokenGuard,
    TenantTokenMatchGuard,
    PermissionsGuard,
  ],
})
export class AttendanceModule {}
