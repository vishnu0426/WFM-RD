import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { EmployeeGrpcClientService } from './employee-grpc-client.service';
import { EMPLOYEE_GRPC_PACKAGE } from './employee-grpc-client.constants';

/**
 * §7 Phase 3/ADR-0099. `protoPath` points at core's own checked-in proto -
 * no local copy in this service, same "single source of truth lives with
 * the owning service" posture as every other service's identical gRPC
 * client module. Resolved from `process.cwd()`, not `__dirname`, for the
 * same reason every other gRPC client module in this platform uses it.
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
