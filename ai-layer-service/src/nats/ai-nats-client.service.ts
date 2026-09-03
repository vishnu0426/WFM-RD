import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { connect, NatsConnection, StringCodec } from 'nats';

const codec = StringCodec();
const CONNECT_TIMEOUT_MS = 1000;
const RECONNECT_COOLDOWN_MS = 5000;

/**
 * Own, independent copy of attendance-leave-service's/shift-marketplace-service's/
 * intraday-service's NATS client (ADR-0039 precedent: each service owns its
 * NATS client rather than sharing one). This service's first NATS presence -
 * Phase 1 through 4 deliberately had none (the `AGNO_AI_LAYER_EVENTS`/
 * `AGNO_AI_LAYER_DLQ` streams were provisioned in Phase 2, ahead of this,
 * their first real publisher).
 */
@Injectable()
export class AiNatsClientService implements OnModuleDestroy {
  private readonly logger = new Logger(AiNatsClientService.name);
  private connection: NatsConnection | null = null;
  private connecting: Promise<NatsConnection> | null = null;
  private lastConnectFailureAt = 0;

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
