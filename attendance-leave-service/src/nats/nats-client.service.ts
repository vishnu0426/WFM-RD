import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { connect, NatsConnection, StringCodec } from 'nats';

const codec = StringCodec();
const CONNECT_TIMEOUT_MS = 1000;
const RECONNECT_COOLDOWN_MS = 5000;

/**
 * Own, independent copy of intraday-service's `IntradayNatsClientService`
 * (ADR-0039 precedent: each service owns its NATS client rather than
 * sharing one, so no service's connection lifecycle/outage handling is
 * coupled to another's). This service's first NATS presence of any kind -
 * Phase 1 through 4 deliberately had none.
 *
 * Unlike intraday's copy, `publish` accepts an optional `msgId` - JetStream's
 * native `Nats-Msg-Id` dedup mechanism, used by `DecideLeaveRequestService`
 * keyed on `leaveRequestId` (a decision is recorded at most once, ADR-0074's
 * `LeaveRequestAlreadyDecidedError` guard, so `leaveRequestId` is already a
 * natural, stable dedup key - no separate id-generation scheme needed).
 */
@Injectable()
export class AttendanceLeaveNatsClientService implements OnModuleDestroy {
  private readonly logger = new Logger(AttendanceLeaveNatsClientService.name);
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
