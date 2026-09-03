import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { AuditGrpcClientService } from './audit-grpc-client.service';
import { AUDIT_GRPC_PACKAGE } from './audit-grpc-client.constants';

/**
 * §2.2 rule 3 (Module 01's platform-wide non-negotiable, exercised for the
 * first time by this module per this document's own §2.2 rule 3 framing):
 * every `AIInteraction`/`AIRecommendation` feeds Module 01's `AuditLog` with
 * `actor_type: ai_agent` and `ai_rationale` populated. Own copy of every
 * other Node service's identical `AuditGrpcClientModule` (ADR-0079's
 * precedent) - not a new mechanism.
 *
 * `protoPath` points at core's own checked-in proto - no local copy, same
 * "single source of truth lives with the owning service" posture every
 * other cross-service proto reference in this platform follows.
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
