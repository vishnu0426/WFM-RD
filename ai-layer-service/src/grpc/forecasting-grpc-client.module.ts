import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { ForecastingGrpcClientService } from './forecasting-grpc-client.service';
import { FORECASTING_GRPC_PACKAGE } from './forecasting-grpc-client.constants';

/**
 * Phase 4 (docs/adr/0119): `explainForecast`'s data source -
 * `ForecastExplanationDataService`, a new gRPC surface this phase added to
 * forecasting-service itself. Own copy of `SchedulingGrpcClientModule`'s
 * shape.
 */
@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: FORECASTING_GRPC_PACKAGE,
        useFactory: () => ({
          transport: Transport.GRPC,
          options: {
            package: 'agno.forecasting.v1',
            protoPath: join(process.cwd(), '../forecasting-service/app/grpc/proto/forecast_explanation_data.proto'),
            url: process.env.FORECASTING_GRPC_URL ?? 'localhost:6000',
          },
        }),
      },
    ]),
  ],
  providers: [ForecastingGrpcClientService],
  exports: [ForecastingGrpcClientService],
})
export class ForecastingGrpcClientModule {}
