import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { withTenantConnection } from '../database/with-tenant-connection';
import { DurableConsumerBinding } from '../nats/bind-durable-consumer';
import { DurableJetStreamConsumer } from '../nats/durable-jetstream-consumer.base';
import { IntradayNatsClientService } from '../nats/nats-client.service';
import { AgentStateChangedPayload, INTRADAY_STREAM_NAME, INTRADAY_SUBJECTS } from '../nats/subjects';
import { IntradayRedisService } from '../redis/redis.service';
import { computeDeviationSeconds } from './adherence-rule';
import { AdherenceEvent } from './entities/adherence-event.entity';
import { AdherenceException } from './entities/adherence-exception.entity';

/**
 * §4.3/§8 Phase 3: a **second, independent** durable consumer on the same
 * `agent.state_changed` subject `AgentStateChangedConsumerService` (Phase
 * 2) already consumes - the module prompt's own architecture ("Consumers:
 * Redis state updater, adherence calculator...") made real. JetStream
 * supports multiple independent durable consumers per subject (already
 * proven by the Phase 2 schedule-sync consumers coexisting).
 *
 * Deliberately does **not** read `from_activity` off Redis's current
 * `AgentLiveState` - by the time this runs, `AgentStateChangedConsumerService`
 * may have already overwritten it with *this same event's* new value,
 * which would make `from`/`to` indistinguishable. Instead it reads this
 * employee's own most recent `AdherenceEvent` row from Postgres
 * (self-referential, race-free with the other consumer) - see ADR-0067.
 * Only `scheduledActivity` is read from Redis, and that's race-free too:
 * it's a field only `ScheduledActivityService` (a wholly separate
 * pipeline) ever writes.
 */
@Injectable()
export class AdherenceCalculatorConsumerService extends DurableJetStreamConsumer<AgentStateChangedPayload> {
  protected readonly logger = new Logger(AdherenceCalculatorConsumerService.name);

  constructor(
    natsClient: IntradayNatsClientService,
    private readonly redis: IntradayRedisService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    super(natsClient);
  }

  protected binding(): DurableConsumerBinding {
    return {
      stream: INTRADAY_STREAM_NAME,
      durableName: 'intraday-adherence-calculator',
      filterSubject: `${INTRADAY_SUBJECTS.AGENT_STATE_CHANGED_PREFIX}.>`,
    };
  }

  /**
   * Public (widened from the base class's `protected abstract`) so unit
   * tests can call it directly without a real `JsMsg`. A thrown error here
   * `nak()`s (base class) rather than silently dropping the compliance
   * record - `AdherenceEvent` is the durable record §6.1's whole ethos
   * says must never look fine while quietly being wrong; a Postgres outage
   * shows up as consumer lag, not a missing row.
   *
   * Also writes an `AdherenceException` row whenever the segment that just
   * ended had a nonzero `deviationSeconds` - see that entity's own doc
   * comment. `computeDeviationSeconds` returning > 0 already guarantees
   * `previousEvent` is non-null and was genuinely non-adherent (ADR-0067),
   * so this never has to re-derive that from scratch here.
   */
  async handlePayload(payload: AgentStateChangedPayload): Promise<void> {
    const eventTimestamp = new Date(payload.receivedAt);

    await withTenantConnection(this.dataSource, payload.tenantId, async (manager) => {
      const repository = manager.getRepository(AdherenceEvent);
      const previousEvent = await repository.findOne({
        where: { tenantId: payload.tenantId, employeeId: payload.employeeId },
        order: { timestamp: 'DESC' },
      });

      const liveState = await this.redis.readAgentLiveState(payload.tenantId, payload.employeeId);
      const scheduledActivity = liveState?.scheduledActivity ?? null;

      const event = new AdherenceEvent();
      event.id = randomUUID();
      event.tenantId = payload.tenantId;
      event.employeeId = payload.employeeId;
      event.eventType = 'activity_changed';
      event.fromActivity = previousEvent?.toActivity ?? null;
      event.toActivity = payload.currentActivity;
      event.scheduledActivity = scheduledActivity;
      event.deviationSeconds = computeDeviationSeconds(previousEvent, eventTimestamp);
      event.timestamp = eventTimestamp;

      await repository.insert(event);

      if (event.deviationSeconds > 0 && previousEvent !== null) {
        const exception = new AdherenceException();
        exception.id = randomUUID();
        exception.tenantId = payload.tenantId;
        exception.employeeId = payload.employeeId;
        exception.activity = previousEvent.toActivity;
        exception.scheduledActivity = previousEvent.scheduledActivity;
        exception.startedAt = previousEvent.timestamp;
        exception.endedAt = eventTimestamp;
        exception.deviationSeconds = event.deviationSeconds;
        exception.status = 'open';
        exception.acknowledgedBy = null;
        exception.acknowledgedAt = null;
        exception.resolutionNotes = null;
        exception.resolvedAt = null;
        exception.createdAt = eventTimestamp;

        await manager.getRepository(AdherenceException).insert(exception);
      }
    });
  }
}
