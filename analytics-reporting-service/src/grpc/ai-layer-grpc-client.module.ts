import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { AiLayerGrpcClientService } from './ai-layer-grpc-client.service';
import { AI_LAYER_GRPC_PACKAGE } from './ai-layer-grpc-client.constants';

/**
 * ADR-0165: this service's first gRPC client of any kind - calls Module
 * 10's (ai-layer-service) new `NlQueryBridgeService.TranslateQuestion`/
 * `GenerateAnswer` for `askAnalyticsQuestion` (ADR-0111). `protoPath`
 * points at ai-layer-service's own checked-in proto - no local copy in
 * this service, same "single source of truth lives with the owning
 * service" posture as every other gRPC client module in this platform
 * (e.g. adherence-compliance-service's `EmployeeGrpcClientModule` pointing
 * at core's own `employee.proto`). Resolved from `process.cwd()`, not
 * `__dirname`, for the same reason every other gRPC client module here
 * does.
 */
@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: AI_LAYER_GRPC_PACKAGE,
        useFactory: () => ({
          transport: Transport.GRPC,
          options: {
            package: 'agno.ai_layer.v1',
            protoPath: join(process.cwd(), '../ai-layer-service/src/grpc/proto/nl_query_bridge.proto'),
            url: process.env.AI_LAYER_GRPC_URL ?? 'localhost:7300',
          },
        }),
      },
    ]),
  ],
  providers: [AiLayerGrpcClientService],
  exports: [AiLayerGrpcClientService],
})
export class AiLayerGrpcClientModule {}
