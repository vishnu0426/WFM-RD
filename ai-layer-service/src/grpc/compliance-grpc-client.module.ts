import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { ComplianceGrpcClientService } from './compliance-grpc-client.service';
import { COMPLIANCE_GRPC_PACKAGE } from './compliance-grpc-client.constants';

/**
 * Phase 4 (docs/adr/0121): `rootCauseAnalysis`'s adherence data source -
 * `AdherenceRollupService`, a new gRPC surface this phase added to
 * adherence-compliance-service itself (its second, alongside the existing
 * `ComplianceRuleService` - both live in the same `compliance.proto`/
 * process/port). Own copy of `SchedulingGrpcClientModule`'s shape.
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
            protoPath: join(process.cwd(), '../adherence-compliance-service/src/grpc/proto/compliance.proto'),
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
