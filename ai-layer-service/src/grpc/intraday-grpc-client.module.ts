import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { IntradayGrpcClientService } from './intraday-grpc-client.service';
import { INTRADAY_GRPC_PACKAGE } from './intraday-grpc-client.constants';

/**
 * Phase 4 (docs/adr/0120/0122): `explainReallocation`/`rootCauseAnalysis`'s
 * intraday data source - `ReallocationService`, this platform's first-ever
 * gRPC server on Module 05 (a new gRPC surface this phase added to
 * intraday-service itself). Own copy of `SchedulingGrpcClientModule`'s shape.
 */
@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: INTRADAY_GRPC_PACKAGE,
        useFactory: () => ({
          transport: Transport.GRPC,
          options: {
            package: 'agno.intraday.v1',
            protoPath: join(process.cwd(), '../intraday-service/src/grpc/proto/reallocation.proto'),
            url: process.env.INTRADAY_GRPC_URL ?? 'localhost:7200',
          },
        }),
      },
    ]),
  ],
  providers: [IntradayGrpcClientService],
  exports: [IntradayGrpcClientService],
})
export class IntradayGrpcClientModule {}
