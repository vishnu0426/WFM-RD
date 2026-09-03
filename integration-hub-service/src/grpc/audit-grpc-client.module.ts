import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { AuditGrpcClientService } from './audit-grpc-client.service';
import { AUDIT_GRPC_PACKAGE } from './audit-grpc-client.constants';

/**
 * Own copy of adherence-compliance-service's/attendance-leave-service's
 * identical `AuditGrpcClientModule` - this platform's next adopter of
 * core's `AuditService.RecordEvent` (ADR-0079), not a new mechanism.
 *
 * `protoPath` points at core's own checked-in proto - no local copy, same
 * "single source of truth lives with the owning service" posture this
 * service's other gRPC-adjacent config already follows.
 */
@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: AUDIT_GRPC_PACKAGE,
        useFactory: () => ({
          transport: Transport.GRPC,
          options: {
            package: 'agno.core.v1',
            protoPath: join(process.cwd(), '../src/grpc/proto/audit.proto'),
            url: process.env.CORE_GRPC_URL ?? 'localhost:5000',
          },
        }),
      },
    ]),
  ],
  providers: [AuditGrpcClientService],
  exports: [AuditGrpcClientService],
})
export class AuditGrpcClientModule {}
