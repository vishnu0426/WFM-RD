import { Module } from '@nestjs/common';
import { ComplianceRuleGrpcController } from './controllers/compliance-rule-grpc.controller';
import { AdherenceRollupGrpcController } from './controllers/adherence-rollup-grpc.controller';
import { ComplianceModule } from '../compliance/compliance.module';
import { AdherenceModule } from '../adherence/adherence.module';

/**
 * §7 Phase 4/ADR-0100: this service's first gRPC surface, same "controller
 * registered via a module in AppModule's import graph, actually served by
 * `connectMicroservice` in main.ts" pattern as core's/attendance-leave-service's
 * own `grpc.module.ts`. `ComplianceRuleGrpcController` calls
 * `ComplianceRuleService` directly (no separate repository layer, matching
 * this service's own established convention), so `ComplianceModule` is the
 * only import needed.
 *
 * Module 10 Phase 4 (docs/adr/0121) adds `AdherenceRollupGrpcController` -
 * this service's second gRPC surface, same process/port/package
 * (`agno.compliance.v1`), calling `AdherenceRollupService` directly.
 */
@Module({
  imports: [ComplianceModule, AdherenceModule],
  controllers: [ComplianceRuleGrpcController, AdherenceRollupGrpcController],
})
export class GrpcModule {}
