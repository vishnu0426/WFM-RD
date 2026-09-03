import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { AuditGrpcClientService } from './audit-grpc-client.service';
import { AUDIT_GRPC_PACKAGE } from './audit-grpc-client.constants';

/** Own copy of integration-hub-service's identical `AuditGrpcClientModule`. `protoPath` points at core's own checked-in proto - no local copy. */
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
