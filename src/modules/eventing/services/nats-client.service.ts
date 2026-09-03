import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { connect, NatsConnection, StringCodec } from 'nats';

const codec = StringCodec();
const CONNECT_TIMEOUT_MS = 1000;
/**
 * If a connection attempt just failed, don't retry for this long - without
 * this, a batch of N outbox events with NATS unreachable pays N full
 * connection timeouts back-to-back (`OutboxPublisherService` calls
 * `publish` once per event), turning one broker outage into a
 * multi-minute tick. A short cooldown means the rest of that batch fails
 * fast off the cached failure instead.
 */
const RECONNECT_COOLDOWN_MS = 5000;

/**
 * Thin, resilient wrapper around a NATS JetStream connection
 * (`NATS_URL`, default `nats://localhost:4222`). Connects lazily on first
 * publish attempt, not at app boot - `AppModule` must be able to start
 * (and every other endpoint must keep working) whether or not a NATS
 * broker is actually reachable in a given environment, exactly the same
 * posture this repo already takes toward Postgres being reachable being a
 * runtime concern, not a compile-time one. `OutboxPublisherService` is the
 * only caller - a failed `publish()` just leaves the outbox row
 * unpublished for the next tick to retry (ADR-0019).
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
   * (`msgID` below) - the stream's duplicate-window then de-dupes a
   * publish that's retried after an ack was lost or after a reclaimed
   * outbox-batch lease (`OutboxEventsRepository.findUnpublishedBatch`)
   * causes the same row to be attempted twice. Callers pass the outbox
   * row's own `id`, which is unique per logical event by construction.
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
