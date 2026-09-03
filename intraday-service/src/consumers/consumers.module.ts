import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AlertingModule } from '../alerting/alerting.module';
import { MetricsModule } from '../common/metrics/metrics.module';
import { GraphQLPubSubModule } from '../graphql/pubsub.module';
import { ReallocationModule } from '../reallocation/reallocation.module';
import { ScheduledActivityModule } from '../schedule/scheduled-activity.module';
import { StaffingOffersModule } from '../staffing-offers/staffing-offers.module';
import { AgentStateChangedConsumerService } from './agent-state-changed.consumer';
import { AssignmentChangedConsumerService } from './assignment-changed.consumer';
import { NatsConsumerLagMonitorService } from './nats-consumer-lag-monitor.service';
import { QueueMetricsUpdatedConsumerService } from './queue-metrics-updated.consumer';
import { SchedulePublishedConsumerService } from './schedule-published.consumer';

/** Phase 2/4's durable JetStream consumers (`DurableJetStreamConsumer` subclasses) - see each file's own doc comment. `AlertingModule` - Phase 5's `QueueMetricsUpdatedConsumerService` now calls `AlertEngineService` after its Redis write. `ReallocationModule` - Phase 6 adds a `ReallocationRecommendationService` call alongside it. `StaffingOffersModule` adds a `StaffingOfferService` call alongside those two (VTO/overtime detection + push-trigger). `NatsConsumerLagMonitorService` - Phase 7's observability addition, not itself a JetStream consumer. */
@Module({
  imports: [
    ConfigModule,
    ScheduledActivityModule,
    GraphQLPubSubModule,
    AlertingModule,
    ReallocationModule,
    StaffingOffersModule,
    MetricsModule,
  ],
  providers: [
    AgentStateChangedConsumerService,
    SchedulePublishedConsumerService,
    AssignmentChangedConsumerService,
    QueueMetricsUpdatedConsumerService,
    NatsConsumerLagMonitorService,
  ],
})
export class ConsumersModule {}
