import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { ComplianceGrpcClientService } from './compliance-grpc-client.service';
import { COMPLIANCE_GRPC_PACKAGE } from './compliance-grpc-client.constants';

/**
 * §0.6/ADR-0101. `protoPath` points at Module 08's own checked-in proto
 * (`adherence-compliance-service/`, a sibling... actually a direct
 * subdirectory of this repo's own root, unlike every other service's own
 * client modules which go `../` to reach root) - "single source of truth
 * lives with the owning service," same posture as every other gRPC client
 * module in this platform, just now pointed the other direction.
 */
@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: COMPLIANCE_GRPC_PACKAGE,
        useFactory: () => ({
          transport: Transport.GRPC,
          options: {
            package: 'agno.compliance.v1',
            protoPath: join(process.cwd(), 'adherence-compliance-service/src/grpc/proto/compliance.proto'),
            url: process.env.COMPLIANCE_GRPC_URL ?? 'localhost:7100',
          },
        }),
      },
    ]),
  ],
  providers: [ComplianceGrpcClientService],
  exports: [ComplianceGrpcClientService],
})
export class ComplianceGrpcClientModule {}
