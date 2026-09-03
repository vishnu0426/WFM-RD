import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MetricsService } from '../common/metrics/metrics.service';
import { IntradayNatsClientService } from '../nats/nats-client.service';
import { INTRADAY_STREAM_NAME } from '../nats/subjects';

/**
 * §7's cross-cutting observability ask names "NATS consumer lag per
 * subject" specifically for this module - `MetricsService`'s own doc
 * comment has flagged this as an open gap since Phase 1 ("consumer lag has
 * no meaning until Phase 2 has a consumer to lag" - Phase 2 shipped three
 * consumers, the metric was never added). `jsm.consumers.info(stream,
 * durableName)` already returns `num_pending`/`num_ack_pending` - this
 * service is the first thing to actually call it.
 *
 * A hardcoded list of this service's five known durable consumer names,
 * not a generalized registry - matching the low-ceremony style already
 * used elsewhere for a small, fixed set (e.g.
 * `AlertEscalationSchedulerService`'s raw SQL). Update this list if a new
 * durable consumer is ever added.
 */
const DURABLE_CONSUMER_NAMES = [
  'intraday-agent-state-changed',
  'intraday-adherence-calculator',
  'intraday-schedule-published',
  'intraday-assignment-changed',
  'intraday-queue-metrics-updated',
  'intraday-queue-metrics-snapshot',
] as const;

@Injectable()
export class NatsConsumerLagMonitorService {
  private readonly logger = new Logger(NatsConsumerLagMonitorService.name);

  constructor(
    private readonly natsClient: IntradayNatsClientService,
    private readonly metrics: MetricsService,
  ) {}

  @Cron('*/30 * * * * *')
  async tick(): Promise<void> {
    let jsm;
    try {
      const conn = await this.natsClient.getConnection();
      jsm = await conn.jetstreamManager();
    } catch (err) {
      this.logger.warn(`Skipping consumer-lag tick - NATS unavailable: ${(err as Error).message}`);
      return;
    }

    for (const durableName of DURABLE_CONSUMER_NAMES) {
      try {
        const info = await jsm.consumers.info(INTRADAY_STREAM_NAME, durableName);
        this.metrics.setNatsConsumerLag(durableName, info.num_pending);
      } catch (err) {
        // A consumer that hasn't bound yet (e.g. right after a fresh boot)
        // throws "consumer not found" - not an error worth logging on
        // every tick, just skip it this round.
        this.logger.debug(`Could not read consumer info for ${durableName}: ${(err as Error).message}`);
      }
    }
  }
}
