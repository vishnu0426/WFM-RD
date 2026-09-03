import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { SchedulingGrpcClientService } from './scheduling-grpc-client.service';
import { SCHEDULING_GRPC_PACKAGE } from './scheduling-grpc-client.constants';

/**
 * Phase 2 (docs/adr/0115): `explainSchedule`'s data source -
 * `ScheduleExplanationDataService`, a new gRPC surface this phase added to
 * scheduling-service itself (it didn't exist before this module needed it -
 * same "the owning service is the one that has to build the read contract"
 * posture ADR-0059's `ForecastService.GetForecastRequirements` already
 * established for an analogous gap). Own copy of
 * adherence-compliance-service's `ScheduleQueryGrpcClientModule` shape - the
 * platform's existing precedent for a Node service calling
 * scheduling-service's gRPC surface.
 *
 * `protoPath` points at scheduling-service's own checked-in proto - no
 * local copy, same "single source of truth lives with the owning service"
 * posture as every other cross-service proto reference in this platform.
 */
@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: SCHEDULING_GRPC_PACKAGE,
        useFactory: () => ({
          transport: Transport.GRPC,
          options: {
            package: 'agno.scheduling.v1',
            protoPath: join(process.cwd(), '../scheduling-service/app/grpc/proto/schedule_explanation_data.proto'),
            url: process.env.SCHEDULING_GRPC_URL ?? 'localhost:8102',
          },
        }),
      },
    ]),
  ],
  providers: [SchedulingGrpcClientService],
  exports: [SchedulingGrpcClientService],
})
export class SchedulingGrpcClientModule {}
