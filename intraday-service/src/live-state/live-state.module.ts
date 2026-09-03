import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { migratorPoolProvider } from '../database/migrator-pool.provider';
import { AgentLiveStateQueryService } from './agent-live-state-query.service';
import { QueueMetricsSnapshot } from './entities/queue-metrics-snapshot.entity';
import { LiveStateRestController } from './live-state-rest.controller';
import { QueueLiveStateQueryService } from './queue-live-state-query.service';
import { QueueMetricsSnapshotConsumerService } from './queue-metrics-snapshot.consumer';
import { QueueMetricsSnapshotRetentionSchedulerService } from './queue-metrics-snapshot-retention-scheduler.service';

/**
 * §8 Phase 4: the read side of `AgentLiveState`/`QueueLiveState` -
 * `IntradayRedisService`/`DataSource` are already globally injectable, no
 * `imports` needed for those.
 *
 * Phase 7: `QueueMetricsSnapshotConsumerService` (a second, independent
 * durable consumer on `queue.metrics_updated`) and its retention
 * scheduler give `QueueLiveStateQueryService` a real Postgres
 * degraded-fallback source - see each file's own doc comment.
 */
@Module({
  imports: [TypeOrmModule.forFeature([QueueMetricsSnapshot])],
  controllers: [LiveStateRestController],
  providers: [
    migratorPoolProvider,
    AgentLiveStateQueryService,
    QueueLiveStateQueryService,
    QueueMetricsSnapshotConsumerService,
    QueueMetricsSnapshotRetentionSchedulerService,
  ],
  exports: [AgentLiveStateQueryService, QueueLiveStateQueryService],
})
export class LiveStateModule {}
