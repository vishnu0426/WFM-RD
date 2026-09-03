import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { EmployeeGrpcClientService } from './employee-grpc-client.service';
import { EMPLOYEE_GRPC_PACKAGE } from './employee-grpc-client.constants';

/**
 * Phase 4 (ADR-0088): this service's second gRPC client (after
 * `SchedulingEligibilityGrpcClientModule`, ADR-0086), and this platform's
 * first Node-to-Node client of core's own `EmployeeService`
 * (`agno.org.v1`) - every prior consumer of that RPC is Python
 * (scheduling-service's `employee_client.py`). Reaches `hire_date`
 * (added to `SchedulableEmployee` in this same phase, ADR-0088) for
 * `BidRankingService`'s seniority-ranking method.
 *
 * `protoPath` points at core's own checked-in proto - no local copy in
 * this service, same "single source of truth lives with the owning
 * service" posture as `SchedulingEligibilityGrpcClientModule`'s own
 * comment. Resolved from `process.cwd()`, not `__dirname`, for the same
 * reason every other gRPC client module in this platform uses it.
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
  providers: [EmployeeGrpcClientService],
  exports: [EmployeeGrpcClientService],
})
export class EmployeeGrpcClientModule {}
