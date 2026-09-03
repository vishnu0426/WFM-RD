import { Module } from '@nestjs/common';
import { LeaveGrpcController } from './controllers/leave-grpc.controller';
import { TenantContextModule } from '../common/tenant/tenant-context.module';

/**
 * §3.4/Phase 5's internal gRPC surface, same "controller registered via a
 * module in AppModule's import graph, actually served by
 * `connectMicroservice` in main.ts" pattern as core `src/grpc/grpc.module.ts`.
 * `LeaveGrpcController` reads `LeaveRequest` directly via `DataSource` (this
 * service's established convention throughout - no repository layer), so
 * there's no feature module to import here beyond tenant context.
 */
@Module({
  imports: [TenantContextModule],
  controllers: [LeaveGrpcController],
})
export class GrpcModule {}
