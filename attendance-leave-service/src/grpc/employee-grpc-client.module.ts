import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { EmployeeGrpcClientService } from './employee-grpc-client.service';
import { EmployeeSessionVerificationService } from './employee-session-verification.service';
import { EMPLOYEE_GRPC_PACKAGE } from './employee-grpc-client.constants';
import { MetricsModule } from '../common/metrics/metrics.module';

/**
 * ADR-0150/ADR-0157: this service's first `EmployeeService` client - calls
 * `GetEmployeeIdForUser`, and (Attendance & Leave Manager Views phase)
 * `GetSchedulableEmployees` for manager-scoped org-unit roster resolution.
 * Same `CORE_GRPC_URL`, same
 * `process.cwd()`-relative proto path reasoning as
 * `calendar-grpc-client.module.ts`/`audit-grpc-client.module.ts` - see
 * those files' own doc comments. `protoPath` points at core's own
 * checked-in proto - no local copy here, same "single source of truth
 * lives with the owning service" posture as every other gRPC client module
 * in this platform.
 *
 * Also provides `EmployeeSessionVerificationService`, built on this same
 * client's `getEmployeeIdForUser` - colocated here since it has no reason
 * to exist without this module's gRPC client.
 */
@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: EMPLOYEE_GRPC_PACKAGE,
        useFactory: () => ({
          transport: Transport.GRPC,
          options: {
            package: 'agno.org.v1',
            protoPath: join(process.cwd(), '../src/grpc/proto/employee.proto'),
            url: process.env.CORE_GRPC_URL ?? 'localhost:5000',
          },
        }),
      },
    ]),
    MetricsModule,
  ],
  providers: [EmployeeGrpcClientService, EmployeeSessionVerificationService],
  exports: [EmployeeGrpcClientService, EmployeeSessionVerificationService],
})
export class EmployeeGrpcClientModule {}
