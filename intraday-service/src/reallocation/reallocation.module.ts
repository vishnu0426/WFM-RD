import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReallocationAction } from '../database/entities';
import { ReallocationApprovalService } from './reallocation-approval.service';
import { ReallocationExecutionService } from './reallocation-execution.service';
import { ReallocationQueryService } from './reallocation-query.service';
import { ReallocationRecommendationService } from './reallocation-recommendation.service';
import { ReallocationRestController } from './reallocation-rest.controller';

/** §8 Phase 6: `ReallocationAction` recommendation/execution/approval/query services, plus the REST approval endpoint (the GraphQL resolver lives in `graphql/resolvers/`, wired by `IntradayGraphQLModule`). */
@Module({
  imports: [TypeOrmModule.forFeature([ReallocationAction])],
  controllers: [ReallocationRestController],
  providers: [
    ReallocationExecutionService,
    ReallocationRecommendationService,
    ReallocationApprovalService,
    ReallocationQueryService,
  ],
  exports: [ReallocationRecommendationService, ReallocationApprovalService, ReallocationQueryService],
})
export class ReallocationModule {}
