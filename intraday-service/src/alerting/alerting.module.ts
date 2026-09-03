import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Alert, AlertPolicy } from '../database/entities';
import { migratorPoolProvider } from '../database/migrator-pool.provider';
import { AlertAcknowledgeService } from './alert-acknowledge.service';
import { AlertEngineService } from './alert-engine.service';
import { AlertEscalationSchedulerService } from './alert-escalation-scheduler.service';
import { AlertPipelineService } from './alert-pipeline.service';
import { AlertPolicyService } from './alert-policy.service';
import { AlertQueryService } from './alert-query.service';

/** §8 Phase 5: dedup/suppression/escalation pipeline (`AlertPipelineService`/`AlertEngineService`) plus the query/acknowledge services `AlertResolver` (`graphql/resolvers/`) depends on. */
@Module({
  imports: [TypeOrmModule.forFeature([Alert, AlertPolicy])],
  providers: [
    migratorPoolProvider,
    AlertPolicyService,
    AlertPipelineService,
    AlertEngineService,
    AlertEscalationSchedulerService,
    AlertQueryService,
    AlertAcknowledgeService,
  ],
  exports: [AlertEngineService, AlertQueryService, AlertAcknowledgeService],
})
export class AlertingModule {}
