import { Module } from '@nestjs/common';
import { NlQueryBridgeGrpcController } from './controllers/nl-query-bridge-grpc.controller';
import { AiModule } from '../ai/ai.module';

/**
 * ADR-0165: this service's first gRPC *server* module (every gRPC concern
 * in `src/grpc/` before this was an outbound client to another module) -
 * same "controller registered here, actually served by `connectMicroservice`
 * in main.ts" pattern as adherence-compliance-service's own `grpc.module.ts`.
 * `NlQueryBridgeGrpcController` calls `NlAnalyticsBridgeService` directly,
 * so `AiModule` is the only import needed.
 */
@Module({
  imports: [AiModule],
  controllers: [NlQueryBridgeGrpcController],
})
export class GrpcModule {}
