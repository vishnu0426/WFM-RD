import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { connect, NatsConnection, StringCodec } from 'nats';

const codec = StringCodec();
const CONNECT_TIMEOUT_MS = 1000;
const RECONNECT_COOLDOWN_MS = 5000;

/**
 * ADR-0039: a deliberate, independent copy of Module 02's `NatsClientService`
 * (`src/modules/eventing/services/nats-client.service.ts`) rather than a
 * shared `common/nats` extraction - see that ADR for the trade-off. Same
 * behavior: connects lazily on first publish attempt (not at app boot), a
 * short reconnect cooldown so an outage doesn't turn one batch into a
 * multi-minute tick, and `CoreOutboxPublisherService` is the only caller.
 */
@Injectable()
export class NatsClientService implements OnModuleDestroy {
  private readonly logger = new Logger(NatsClientService.name);
  private connection: NatsConnection | null = null;
  private connecting: Promise<NatsConnection> | null = null;
  private lastConnectFailureAt = 0;

  private async getConnection(): Promise<NatsConnection> {
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

  /**
   * Publishes to JetStream's underlying core NATS subject; throws if
   * unreachable - the caller decides what "unpublished" means.
   *
   * GAP-14: `msgId`, when passed, becomes JetStream's `Nats-Msg-Id` header
   * (`msgID` below) - see Module 02's identical `NatsClientService.publish`
   * for the full rationale. Callers pass the outbox row's own `id`.
   */
  async publish(subject: string, payload: Record<string, unknown>, msgId?: string): Promise<void> {
    const conn = await this.getConnection();
    const js = conn.jetstream();
    await js.publish(subject, codec.encode(JSON.stringify(payload)), msgId ? { msgID: msgId } : undefined);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.connection) {
      await this.connection.drain();
    }
  }
}
