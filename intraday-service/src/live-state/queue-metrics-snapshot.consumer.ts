import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { withTenantConnection } from '../database/with-tenant-connection';
import { DurableConsumerBinding } from '../nats/bind-durable-consumer';
import { DurableJetStreamConsumer } from '../nats/durable-jetstream-consumer.base';
import { IntradayNatsClientService } from '../nats/nats-client.service';
import { INTRADAY_STREAM_NAME, INTRADAY_SUBJECTS, QueueMetricsUpdatedPayload } from '../nats/subjects';
import { QueueMetricsSnapshot } from './entities/queue-metrics-snapshot.entity';

/**
 * §6.1/§8 Phase 7: a **second, independent** durable consumer on the same
 * `queue.metrics_updated` subject `QueueMetricsUpdatedConsumerService`
 * (Phase 4) already consumes - the same "one subject, multiple
 * independent durable consumers, one per concern" precedent
 * `AdherenceCalculatorConsumerService` already established alongside
 * `AgentStateChangedConsumerService` on `agent.state_changed` (Phase 3).
 * Deliberately kept separate from `QueueMetricsUpdatedConsumerService`
 * (which already does Redis write + alert eval + reallocation eval +
 * PubSub publish across Phases 4-6) rather than adding a fifth
 * responsibility to it.
 *
 * Writes one `QueueMetricsSnapshot` row per event - the queue-side
 * equivalent of `AdherenceEvent`'s role, giving
 * `QueueLiveStateQueryService` a real Postgres degraded-fallback source
 * for the first time (Phase 4's own checklist flagged this as not done).
 */
@Injectable()
export class QueueMetricsSnapshotConsumerService extends DurableJetStreamConsumer<QueueMetricsUpdatedPayload> {
  protected readonly logger = new Logger(QueueMetricsSnapshotConsumerService.name);

  constructor(
    natsClient: IntradayNatsClientService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    super(natsClient);
  }

  protected binding(): DurableConsumerBinding {
    return {
      stream: INTRADAY_STREAM_NAME,
      durableName: 'intraday-queue-metrics-snapshot',
      filterSubject: INTRADAY_SUBJECTS.QUEUE_METRICS_UPDATED,
    };
  }

  /** Public (widened from the base class's `protected abstract`) so unit tests can call it directly without a real `JsMsg`. */
  async handlePayload(payload: QueueMetricsUpdatedPayload): Promise<void> {
    await withTenantConnection(this.dataSource, payload.tenantId, async (manager) => {
      const snapshot = new QueueMetricsSnapshot();
      snapshot.id = randomUUID();
      snapshot.tenantId = payload.tenantId;
      snapshot.queueId = payload.queueId;
      snapshot.currentVolume = payload.currentVolume;
      snapshot.agentsAvailable = payload.agentsAvailable;
      snapshot.agentsOnCall = payload.agentsOnCall;
      snapshot.forecastedVolume = payload.forecastedVolume;
      snapshot.serviceLevelCurrent = payload.serviceLevelCurrent;
      snapshot.serviceLevelTarget = payload.serviceLevelTarget;
      snapshot.capturedAt = new Date();

      await manager.getRepository(QueueMetricsSnapshot).insert(snapshot);
    });
  }
}
