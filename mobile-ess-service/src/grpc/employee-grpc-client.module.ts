import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { EmployeeGrpcClientService } from './employee-grpc-client.service';
import { EmployeeSessionVerificationService } from './employee-session-verification.service';
import { EMPLOYEE_GRPC_PACKAGE } from './employee-grpc-client.constants';

/**
 * ADR-0155: this service's first `EmployeeService` client - calls only
 * `GetEmployeeOrgUnits` (the RPC ADR-0099 added to close exactly this
 * "employeeId -> orgUnitId" gap for another consumer,
 * `adherence-compliance-service`; this is a second, independent consumer
 * of the same already-live RPC, own copy of that service's identical
 * client shape, narrowed to the one method this service actually needs).
 * `protoPath` points at core's own checked-in proto - no local copy here,
 * same "single source of truth lives with the owning service" posture as
 * every other gRPC client module in this platform.
 *
 * Also provides `EmployeeSessionVerificationService` (ADR-0150/ADR-0157),
 * built on this same client's `getEmployeeIdForUser` - colocated here since
 * it has no reason to exist without this module's gRPC client.
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
  ],
  providers: [EmployeeGrpcClientService, EmployeeSessionVerificationService],
  exports: [EmployeeGrpcClientService, EmployeeSessionVerificationService],
})
export class EmployeeGrpcClientModule {}
