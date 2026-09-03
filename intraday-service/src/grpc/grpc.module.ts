import { Module } from '@nestjs/common';
import { ReallocationGrpcController } from './controllers/reallocation-grpc.controller';
import { ReallocationModule } from '../reallocation/reallocation.module';

/**
 * Module 10 Phase 4 (docs/adr/0120): this service's first gRPC surface,
 * same "controller registered via a module in AppModule's import graph,
 * actually served by `connectMicroservice` in main.ts" pattern as core's/
 * adherence-compliance-service's own `grpc.module.ts`.
 */
@Module({
  imports: [ReallocationModule],
  controllers: [ReallocationGrpcController],
})
export class GrpcModule {}
