import { Module } from '@nestjs/common';
import { TenantContextModule } from '../common/tenant/tenant-context.module';
import { AuditGrpcClientModule } from '../grpc/audit-grpc-client.module';
import { ScorecardSourcesService } from './scorecard-sources.service';

/** Tenant Admin Integration Management, WP6. Owns `ScorecardSourcesService`; `ScorecardSourceResolver` lives in `AnalyticsGraphQLModule` (this service's one GraphQL schema, same convention `AnalyticsModule`/`AnalyticsGraphQLModule` already split). */
@Module({
  imports: [TenantContextModule, AuditGrpcClientModule],
  providers: [ScorecardSourcesService],
  exports: [ScorecardSourcesService],
})
export class ScorecardsModule {}
