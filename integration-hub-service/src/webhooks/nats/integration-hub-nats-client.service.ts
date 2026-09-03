import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { connect, NatsConnection, StringCodec } from 'nats';

const codec = StringCodec();
const CONNECT_TIMEOUT_MS = 1000;
const RECONNECT_COOLDOWN_MS = 5000;

/**
 * §7 Phase 7's own copy of intraday-service's `IntradayNatsClientService`/
 * every other service's own copy (ADR-0039's precedent: each module/
 * service owns its NATS client rather than sharing one, so no service's
 * outage-handling or connection lifecycle is coupled to another's). Same
 * behavior: connects lazily on first publish (not at app boot), a short
 * reconnect cooldown so an outage doesn't turn one request into a multi-
 * second stall per retry.
 *
 * Unlike `IntradayNatsClientService` (a hard dependency the ingestion path
 * throws on), `publish()` here is deliberately used as a best-effort call
 * by `SyncJobsService.complete()` (its own doc comment) - a NATS outage
 * must never fail a real `SyncJob` completion write, so callers catch and
 * log rather than propagate.
 */
@Injectable()
export class IntegrationHubNatsClientService implements OnModuleDestroy {
  private readonly logger = new Logger(IntegrationHubNatsClientService.name);
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
  async publish(subject: string, payload: Record<string, unknown>): Promise<void> {
    const conn = await this.getConnection();
    const js = conn.jetstream();
    await js.publish(subject, codec.encode(JSON.stringify(payload)));
  }

  async onModuleDestroy(): Promise<void> {
    if (this.connection) {
      await this.connection.drain();
    }
  }
}
