import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { connect, NatsConnection, StringCodec } from 'nats';
import { MetricsService } from '../common/metrics/metrics.service';

const codec = StringCodec();
const CONNECT_TIMEOUT_MS = 1000;
const RECONNECT_COOLDOWN_MS = 5000;

/**
 * Own, independent copy of attendance-leave-service's/intraday-service's
 * NATS client (ADR-0039 precedent: each service owns its NATS client
 * rather than sharing one). This service's first NATS presence - Phase 1
 * through 4 deliberately had none (`app.module.ts`'s own doc comment).
 */
@Injectable()
export class MarketplaceNatsClientService implements OnModuleDestroy {
  private readonly logger = new Logger(MarketplaceNatsClientService.name);
  private connection: NatsConnection | null = null;
  private connecting: Promise<NatsConnection> | null = null;
  private lastConnectFailureAt = 0;

  constructor(private readonly metrics: MetricsService) {}

  async getConnection(): Promise<NatsConnection> {
    if (this.connection) {
      return this.connection;
    }
    if (!this.connecting) {
      if (Date.now() - this.lastConnectFailureAt < RECONNECT_COOLDOWN_MS) {
        throw new Error(
          `NATS connection recently failed - cooling down before retrying ${process.env.NATS_URL ?? 'nats://localhost:4222'}`,
        );
      }
      this.connecting = connect({
        servers: process.env.NATS_URL ?? 'nats://localhost:4222',
        timeout: CONNECT_TIMEOUT_MS,
      })
        .then((conn) => {
          this.connection = conn;
          this.logger.log(`Connected to NATS at ${process.env.NATS_URL ?? 'nats://localhost:4222'}`);
          return conn;
        })
        .catch((err) => {
          this.lastConnectFailureAt = Date.now();
          throw err;
        })
        .finally(() => {
          this.connecting = null;
        });
    }
    return this.connecting;
  }

  /** Publishes to JetStream's underlying core NATS subject; throws if unreachable - the caller decides what "unpublished" means. */
  async publish(subject: string, payload: Record<string, unknown>, msgId?: string): Promise<void> {
    const start = process.hrtime.bigint();
    try {
      const conn = await this.getConnection();
      const js = conn.jetstream();
      await js.publish(subject, codec.encode(JSON.stringify(payload)), msgId ? { msgID: msgId } : undefined);
      this.metrics.natsPublishTotal.inc({ subject, result: 'success' });
    } catch (err) {
      this.metrics.natsPublishTotal.inc({ subject, result: 'failure' });
      throw err;
    } finally {
      this.metrics.natsPublishDuration.observe({ subject }, Number(process.hrtime.bigint() - start) / 1e9);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.connection) {
      await this.connection.drain();
    }
  }
}
