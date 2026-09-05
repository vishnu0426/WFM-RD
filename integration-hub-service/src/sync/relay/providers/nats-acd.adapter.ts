import { Injectable, Logger } from '@nestjs/common';
import {
  AckPolicy,
  connect,
  credsAuthenticator,
  nanos,
  nkeyAuthenticator,
  tokenAuthenticator,
  usernamePasswordAuthenticator,
  type Authenticator,
  type Consumer,
  type ConsumerMessages,
  type JsMsg,
  type Msg,
  type NatsConnection,
  type Subscription,
} from 'nats';
import { VaultClientService } from '../../../vault/vault-client.service';
import { FieldMappingsService } from '../../../connectors/field-mappings.service';
import { FieldMapping } from '../../../integrations/entities/field-mapping.entity';
import { applyFieldMappings } from '../../batch/providers/field-mapping-transform';
import { IntegrationConnector } from '../../../integrations/entities/integration-connector.entity';
import { StreamingRelayAdapter, StreamingRelayCallbacks, StreamingRelaySession } from '../streaming-relay-adapter';
import { BackpressureQueue } from './backpressure-queue';
import { ActivityEvent, IntradayActivityEventClient } from './intraday-activity-event-client';
import { IntradayUpstreamDegradedError } from '../../errors/intraday-forwarding.errors';
import { NatsAcdConnectionError } from './nats-acd-client.errors';

/** Real, non-secret NATS topology - lives in `IntegrationConnector.config.settings.onpremNats`, validated by `onpremNatsSetting()` in `config-schemas.ts`. No field here is optional-but-guessed: `useJetStream: true` requires `streamName`/`durableName` because that's what JetStream's own API actually requires to bind a durable consumer. */
export interface OnpremNatsSettings {
  natsUrls: string[];
  subject: string;
  queueGroup?: string;
  useJetStream: boolean;
  streamName?: string;
  durableName?: string;
  ackWaitSeconds?: number;
}

/** Real, secret NATS auth material - Vault-backed via `credentialReference`, never in `config`. Exactly one shape applies per `authType`, matching whichever mechanism the customer's own NATS server enforces (confirmed with them, not guessed - see the class doc comment). */
interface OnpremNatsCredential {
  authType: 'token' | 'userpass' | 'nkey' | 'creds';
  token?: string;
  user?: string;
  pass?: string;
  /** Base64/raw NKey seed text as issued by the customer's NATS operator. */
  nkeySeed?: string;
  /** Full contents of a NATS `.creds` file (JWT + seed), as issued by the customer's NATS operator. */
  credsFile?: string;
  /** PEM contents of the customer's own (likely self-signed, on-prem) CA certificate. */
  tlsCaCert?: string;
}

function hasRequiredActivityFields(record: Record<string, unknown>): boolean {
  return (
    typeof record.employeeId === 'string' &&
    record.employeeId.length > 0 &&
    typeof record.currentActivity === 'string' &&
    record.currentActivity.length > 0 &&
    typeof record.activityStartedAt === 'string' &&
    record.activityStartedAt.length > 0
  );
}

const DEFAULT_ACK_WAIT_SECONDS = 30;

interface QueueItem {
  event: ActivityEvent;
  /** JetStream mode only - undefined for core NATS, which has no ack concept at all. */
  ack?: () => void;
  nak?: () => void;
}

/**
 * The one streaming adapter in this directory that doesn't dial out to a
 * vendor's own cloud API - it subscribes to a message bus the *customer*
 * already runs on-prem, onto which their own ACD integration layer
 * publishes agent-state events. Every other adapter here (Genesys Cloud,
 * Avaya Aura, NICE CXone, Five9, Talkdesk, AXP) is the party that
 * establishes the real-time channel; here the customer's own
 * infrastructure already has one, and this adapter is a subscriber on it.
 * That inverts the two open questions every other adapter answers from
 * public vendor docs into things only the customer can answer:
 * - **Auth mechanism** (`authType`): NATS supports token, username/
 *   password, NKey (public-key), and creds-file (JWT) auth, and a given
 *   server enforces exactly one - there is no way to detect which from
 *   outside, it must be confirmed with the customer's own NATS operator.
 * - **JetStream vs core**: core NATS pub/sub is fire-and-forget - an event
 *   published while this adapter is disconnected (a restart, a deploy, a
 *   network blip) is gone, with no redelivery. JetStream (`useJetStream:
 *   true`) is durable and resumable, but requires the *customer's* NATS
 *   server to have JetStream enabled and a stream already configured on
 *   their end - not something this platform can provision. If the
 *   customer doesn't have it, `useJetStream: false` is the honest
 *   configuration, with the resulting at-most-once delivery disclosed to
 *   them, not silently assumed away.
 *
 * Uses the `nats` package's own reconnect logic (`reconnect: true,
 * maxReconnectAttempts: -1`) rather than the hand-rolled exponential
 * backoff `GenesysCloudAdapter`/`AvayaAuraAdapter` need - unlike a bare
 * WebSocket or raw TCP socket, the NATS client itself already re-subscribes
 * core subscriptions and resumes JetStream pull consumers past a
 * reconnect, so reimplementing that here would just be a worse copy of
 * what the library already does correctly.
 *
 * Message schema is entirely the customer's own (there is no NATS-level
 * concept of an agent-state event) - the same "no universal schema, so
 * `FieldMapping` does the real translation" posture every other adapter
 * takes for its own vendor payload. A message with no per-event unique ID
 * in its own body means `sourceEventId` falls back to this adapter's own
 * counter (core NATS, and JetStream if the customer's payload has no ID
 * field) or the JetStream stream sequence (`msg.seq`, genuinely stable and
 * unique per stream) when available - the same "disclose the gap where a
 * stable ID doesn't exist, don't fabricate one" posture `AvayaAuraAdapter`
 * already established.
 */
@Injectable()
export class NatsAcdAdapter implements StreamingRelayAdapter {
  private readonly logger = new Logger(NatsAcdAdapter.name);
  readonly provider = 'onprem-nats-acd';

  constructor(
    private readonly vault: VaultClientService,
    private readonly fieldMappings: FieldMappingsService,
    private readonly intradayClient: IntradayActivityEventClient,
  ) {}

  async connect(connector: IntegrationConnector, callbacks: StreamingRelayCallbacks): Promise<StreamingRelaySession> {
    const config = connector.config as Record<string, unknown>;
    const settings = ((config.settings as Record<string, unknown> | undefined)?.onpremNats ?? {}) as Partial<OnpremNatsSettings>;
    if (!settings.natsUrls?.length || !settings.subject) {
      throw new NatsAcdConnectionError('connector.config.settings.onpremNats.natsUrls and .subject are required');
    }
    if (settings.useJetStream && (!settings.streamName || !settings.durableName)) {
      throw new NatsAcdConnectionError('settings.onpremNats.streamName and .durableName are required when useJetStream is true');
    }
    if (!config.credentialReference) {
      throw new NatsAcdConnectionError('connector.config.credentialReference is not set');
    }

    const credential = (await this.vault.read(config.credentialReference as string)) as unknown as OnpremNatsCredential;
    const authenticator = this.buildAuthenticator(credential);

    const mappings = await this.fieldMappings.findAllForConnector(connector.tenantId, connector.id);

    let coreSequence = 0;
    const queue = new BackpressureQueue<QueueItem>({
      capacity: 1000,
      process: async (item) => {
        try {
          const result = await this.intradayClient.forward(connector.tenantId, item.event);
          if (result.status === 'accepted') {
            callbacks.onEventForwarded();
          }
          // Accepted or a genuine duplicate (already-seen sourceEventId) are
          // both "this platform is done with this message" - ack either way
          // so a JetStream redelivery timer doesn't keep resending it.
          item.ack?.();
        } catch (err) {
          if (err instanceof IntradayUpstreamDegradedError) {
            throw err;
          }
          this.logger.warn(`Forwarding event ${item.event.sourceEventId} to Module 05 failed: ${(err as Error).message}`);
          callbacks.onEventFailed();
          item.nak?.();
        }
      },
      onDropped: (item, reason) => {
        this.logger.warn(`Dropped event ${item.event.sourceEventId} (${reason})`);
        callbacks.onEventFailed();
        item.nak?.();
      },
    });

    let nc: NatsConnection;
    try {
      nc = await connect({
        servers: settings.natsUrls,
        authenticator,
        tls: credential.tlsCaCert ? { ca: credential.tlsCaCert } : undefined,
        reconnect: true,
        maxReconnectAttempts: -1,
      });
    } catch (err) {
      throw new NatsAcdConnectionError(`connect() failed: ${(err as Error).message}`);
    }

    void nc.closed().then((err) => {
      if (err) {
        this.logger.warn(`On-prem NATS connection for connector ${connector.id} closed with error: ${err.message}`);
      }
    });

    let messages: ConsumerMessages | null = null;
    let coreSub: Subscription | null = null;

    const parseAndEnqueue = (raw: Record<string, unknown>, sourceEventId: string, ack?: () => void, nak?: () => void): void => {
      const transformed = applyFieldMappings(raw, mappings);
      if (!hasRequiredActivityFields(transformed)) {
        callbacks.onEventFailed();
        nak?.();
        return;
      }
      const event: ActivityEvent = {
        sourceEventId,
        employeeId: transformed.employeeId as string,
        currentActivity: transformed.currentActivity as string,
        activityStartedAt: transformed.activityStartedAt as string,
        siteId: typeof transformed.siteId === 'string' ? transformed.siteId : undefined,
        queueId: typeof transformed.queueId === 'string' ? transformed.queueId : undefined,
      };
      queue.enqueue({ event, ack, nak });
    };

    if (settings.useJetStream) {
      try {
        const jsm = await nc.jetstreamManager();
        const ackWaitNanos = nanos((settings.ackWaitSeconds ?? DEFAULT_ACK_WAIT_SECONDS) * 1000);
        const exists = await jsm.consumers.info(settings.streamName!, settings.durableName!).catch(() => null);
        if (!exists) {
          await jsm.consumers.add(settings.streamName!, {
            durable_name: settings.durableName!,
            ack_policy: AckPolicy.Explicit,
            filter_subject: settings.subject,
            ack_wait: ackWaitNanos,
          });
        }
        const js = nc.jetstream();
        const consumer: Consumer = await js.consumers.get(settings.streamName!, settings.durableName!);
        messages = await consumer.consume();
        void this.runJetStreamLoop(messages, parseAndEnqueue);
      } catch (err) {
        await nc.close().catch(() => undefined);
        throw new NatsAcdConnectionError(`JetStream consumer setup failed: ${(err as Error).message}`);
      }
    } else {
      coreSub = nc.subscribe(settings.subject, settings.queueGroup ? { queue: settings.queueGroup } : undefined);
      void this.runCoreLoop(coreSub, (raw) => {
        coreSequence += 1;
        parseAndEnqueue(raw, `${connector.id}:${coreSequence}`);
      });
    }

    return {
      connectorId: connector.id,
      handle: {
        stop: async () => {
          queue.stop();
          messages?.stop();
          coreSub?.unsubscribe();
          await nc.close().catch(() => undefined);
        },
      },
    };
  }

  async disconnect(session: StreamingRelaySession): Promise<void> {
    const handle = session.handle as { stop: () => Promise<void> };
    await handle.stop();
  }

  private async runJetStreamLoop(
    messages: ConsumerMessages,
    onMessage: (raw: Record<string, unknown>, sourceEventId: string, ack: () => void, nak: () => void) => void,
  ): Promise<void> {
    for await (const m of messages as AsyncIterable<JsMsg>) {
      let raw: Record<string, unknown>;
      try {
        raw = m.json<Record<string, unknown>>();
      } catch {
        // Not JSON - nothing this adapter can map; ack so it isn't
        // redelivered forever (it will never become parseable).
        m.ack();
        continue;
      }
      onMessage(raw, `${m.subject}:${m.seq}`, () => m.ack(), () => m.nak());
    }
  }

  private async runCoreLoop(sub: Subscription, onMessage: (raw: Record<string, unknown>) => void): Promise<void> {
    for await (const m of sub as AsyncIterable<Msg>) {
      let raw: Record<string, unknown>;
      try {
        raw = m.json<Record<string, unknown>>();
      } catch {
        continue;
      }
      onMessage(raw);
    }
  }

  private buildAuthenticator(credential: OnpremNatsCredential): Authenticator {
    switch (credential.authType) {
      case 'token':
        if (!credential.token) throw new NatsAcdConnectionError('authType "token" requires a token in the Vault secret');
        return tokenAuthenticator(credential.token);
      case 'userpass':
        if (!credential.user || !credential.pass) {
          throw new NatsAcdConnectionError('authType "userpass" requires user and pass in the Vault secret');
        }
        return usernamePasswordAuthenticator(credential.user, credential.pass);
      case 'nkey':
        if (!credential.nkeySeed) throw new NatsAcdConnectionError('authType "nkey" requires nkeySeed in the Vault secret');
        return nkeyAuthenticator(new TextEncoder().encode(credential.nkeySeed));
      case 'creds':
        if (!credential.credsFile) throw new NatsAcdConnectionError('authType "creds" requires credsFile in the Vault secret');
        return credsAuthenticator(new TextEncoder().encode(credential.credsFile));
      default:
        throw new NatsAcdConnectionError(`unknown authType "${String(credential.authType)}" - must be one of token, userpass, nkey, creds`);
    }
  }
}
