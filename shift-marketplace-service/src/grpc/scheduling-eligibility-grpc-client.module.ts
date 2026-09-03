import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { SchedulingEligibilityGrpcClientService } from './scheduling-eligibility-grpc-client.service';
import { SCHEDULING_ELIGIBILITY_GRPC_PACKAGE } from './scheduling-eligibility-grpc-client.constants';

/**
 * §0/§4/ADR-0082: this module's core non-negotiable - guardrail validation
 * calls Module 04's *own* constraint logic, via the same gRPC surface, not
 * a separately maintained rule set. This is this platform's first
 * Node-to-Python gRPC client (every prior Node gRPC client - Module 06's
 * `AuditGrpcClientModule` - calls another Node service; every prior
 * Python-side gRPC relationship has Python as the *client*, not the
 * server) - `scheduling_eligibility.proto`'s own package/service names are
 * still `agno.scheduling.v1`/`SchedulingEligibilityService`, no different
 * from a same-language contract, since `@grpc/proto-loader` reads the
 * `.proto` file directly rather than any language-specific generated code.
 *
 * `protoPath` points at scheduling-service's own checked-in proto - no
 * local copy in this service, same "single source of truth lives with the
 * owning service" posture as every other cross-service proto reference in
 * this platform (ADR-0078/audit-grpc-client.module.ts's own precedent).
 * Resolved from `process.cwd()`, not `__dirname`, for the same reason
 * `audit-grpc-client.module.ts` documents: `npm run start:dev`/
 * `start:prod` both run from this service's own root, which stays stable
 * across `ts-node` dev mode and a compiled build - `__dirname` does not.
 */
@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: SCHEDULING_ELIGIBILITY_GRPC_PACKAGE,
        useFactory: () => ({
          transport: Transport.GRPC,
          options: {
            package: 'agno.scheduling.v1',
            protoPath: join(process.cwd(), '../scheduling-service/app/grpc/proto/scheduling_eligibility.proto'),
            url: process.env.SCHEDULING_GRPC_URL ?? 'localhost:8102',
          },
        }),
      },
    ]),
  ],
  providers: [SchedulingEligibilityGrpcClientService],
  exports: [SchedulingEligibilityGrpcClientService],
})
export class SchedulingEligibilityGrpcClientModule {}
