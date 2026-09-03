import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { ScheduleQueryGrpcClientService } from './schedule-query-grpc-client.service';
import { SCHEDULE_QUERY_GRPC_PACKAGE } from './schedule-query-grpc-client.constants';

/**
 * Phase 5 (docs/adr/0104): `RuleChangeImpactPreview`'s data source - own
 * copy of shift-marketplace-service's `SchedulingEligibilityGrpcClientModule`
 * shape, the platform's existing precedent for a Node service calling
 * scheduling-service's gRPC surface (`agno.scheduling.v1`, still the
 * package name docs/adr/0103's `schedule_query.proto` declares - no
 * different from a same-language contract, since `@grpc/proto-loader`
 * reads the `.proto` file directly).
 *
 * `protoPath` points at scheduling-service's own checked-in proto - no
 * local copy, same "single source of truth lives with the owning service"
 * posture as every other cross-service proto reference in this platform.
 * Resolved from `process.cwd()`, not `__dirname`, for the same reason this
 * service's own `employee-grpc-client.module.ts`/`calendar-grpc-client.module.ts`
 * already document.
 */
@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: SCHEDULE_QUERY_GRPC_PACKAGE,
        useFactory: () => ({
          transport: Transport.GRPC,
          options: {
            package: 'agno.scheduling.v1',
            protoPath: join(process.cwd(), '../scheduling-service/app/grpc/proto/schedule_query.proto'),
            url: process.env.SCHEDULING_GRPC_URL ?? 'localhost:8102',
          },
        }),
      },
    ]),
  ],
  providers: [ScheduleQueryGrpcClientService],
  exports: [ScheduleQueryGrpcClientService],
})
export class ScheduleQueryGrpcClientModule {}
