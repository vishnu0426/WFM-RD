import { Injectable, Logger } from '@nestjs/common';
import { WebSocket, type RawData } from 'ws';
import { VaultClientService } from '../../../vault/vault-client.service';
import { FieldMappingsService } from '../../../connectors/field-mappings.service';
import { FieldMapping } from '../../../integrations/entities/field-mapping.entity';
import { applyFieldMappings } from '../../batch/providers/field-mapping-transform';
import { IntegrationConnector } from '../../../integrations/entities/integration-connector.entity';
import { StreamingRelayAdapter, StreamingRelayCallbacks, StreamingRelaySession } from '../streaming-relay-adapter';
import { BackpressureQueue } from './backpressure-queue';
import { ActivityEvent, IntradayActivityEventClient } from './intraday-activity-event-client';
import { IntradayUpstreamDegradedError } from '../../errors/intraday-forwarding.errors';
import { AxpApiError } from './axp-api-client.errors';

interface AxpConnectorConfig {
  /** Single base host - AXP's own token endpoint (`/api/auth/v1/...`) and subscriptions endpoint (`/v1/accounts/...`) live under the same per-region host (e.g. `https://na.api.avayacloud.com`), per developers.avayacloud.com's "How to Authenticate" and "Notification Subscriptions" pages. */
  axpApiBaseUrl?: string;
  /** AXP's own tenant-scoping path segment, distinct from this platform's tenantId - required in both the token URL and the subscriptions URL. */
  axpAccountId?: string;
  credentialReference?: string;
  backpressureQueueCapacity?: number;
}

interface AxpCredential {
  clientId?: string;
  clientSecret?: string;
}

interface AxpAgentStateBody {
  event?: string;
  agentId?: string;
  profileId?: string;
  state?: string;
  reasonCode?: string;
  cause?: string;
  id?: string;
  timestamp?: number;
}

interface AxpNotificationFrame {
  event?: string;
  status?: string;
  subscriptionId?: string;
  body?: AxpAgentStateBody;
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

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
/** AXP's own documented default when a subscription response omits `pingInterval`. */
const DEFAULT_PING_INTERVAL_SECONDS = 300;

/**
 * ADR-0167's real `StreamingRelayAdapter` for Avaya Experience Platform
 * (AXP), the cloud Avaya product ADR-0142 left out of Phase 6b's own
 * provider list without ruling out - unlike Avaya Aura Contact Center/CMS
 * (still deferred: that one's real mechanism is TSAPI/CSTA over a licensed
 * AES instance this environment has no access to, per ADR-0142). AXP's own
 * real-time surface, `developers.avayacloud.com`'s "Agent and Engagement
 * Events" docs, is a four-step provisioning dance before any event
 * arrives: OAuth2 client-credentials token
 * (`POST {base}/api/auth/v1/{accountId}/protocol/openid-connect/token`,
 * credentials in the form body, not a Basic-auth header - a genuinely
 * different shape from `GenesysCloudAdapter`'s token call), then
 * `POST {base}/v1/accounts/{accountId}/subscriptions` (returns
 * `subscriptionId`, `transport.endpoint`, and `pingInterval`), then opening
 * a WebSocket to that endpoint and sending a JSON `{event:"authentication",
 * subscriptionId, token}` frame as the very first message (distinct from
 * Genesys, whose token/channel dance is pure REST with no WS-level
 * handshake), then periodic `{event:"ping"}` frames at the server-supplied
 * `pingInterval` to keep the session alive. This environment has no real,
 * credentialed AXP account, so verification runs against a real local
 * server implementing this exact four-step shape - see the Phase 6b
 * follow-up design doc.
 *
 * AXP's own docs don't state whether a closed WebSocket's subscription can
 * be reused - unlike Genesys, where non-resumability is an explicit
 * platform rule. Absent that confirmation, an unexpected `close` takes the
 * same conservative path Genesys does (re-run the full four-step dance
 * rather than a bare reconnect) since a stale/expired `subscriptionId` is a
 * real possibility (subscriptions expire; §"Notification Subscriptions"),
 * not because AXP is known to require it.
 */
@Injectable()
export class AxpAdapter implements StreamingRelayAdapter {
  private readonly logger = new Logger(AxpAdapter.name);
  readonly provider = 'Avaya Experience Platform';

  constructor(
    private readonly vault: VaultClientService,
    private readonly fieldMappings: FieldMappingsService,
    private readonly intradayClient: IntradayActivityEventClient,
  ) {}

  async connect(connector: IntegrationConnector, callbacks: StreamingRelayCallbacks): Promise<StreamingRelaySession> {
    const config = connector.config as AxpConnectorConfig;
    const baseUrl = config.axpApiBaseUrl;
    const accountId = config.axpAccountId;
    if (!baseUrl || !accountId) {
      throw new AxpApiError('connector.config.axpApiBaseUrl and connector.config.axpAccountId are required');
    }
    if (!config.credentialReference) {
      throw new AxpApiError('connector.config.credentialReference is not set');
    }

    const credential = (await this.vault.read(config.credentialReference)) as AxpCredential;
    const clientId = credential.clientId;
    const clientSecret = credential.clientSecret;
    if (!clientId || !clientSecret) {
      throw new AxpApiError('Vault secret has no clientId/clientSecret field');
    }

    const mappings = await this.fieldMappings.findAllForConnector(connector.tenantId, connector.id);

    const queue = new BackpressureQueue<ActivityEvent>({
      capacity: config.backpressureQueueCapacity ?? 1000,
      process: async (event) => {
        try {
          const result = await this.intradayClient.forward(connector.tenantId, event);
          if (result.status === 'accepted') {
            callbacks.onEventForwarded();
          }
        } catch (err) {
          if (err instanceof IntradayUpstreamDegradedError) {
            throw err;
          }
          this.logger.warn(`Forwarding event ${event.sourceEventId} to Module 05 failed: ${(err as Error).message}`);
          callbacks.onEventFailed();
        }
      },
      onDropped: (event, reason) => {
        this.logger.warn(`Dropped event ${event.sourceEventId} (${reason})`);
        callbacks.onEventFailed();
      },
    });

    let stopped = false;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    const initial = await this.provisionAndOpen(baseUrl, accountId, clientId, clientSecret);
    let currentSocket = initial.socket;
    const pingIntervalMs = initial.pingIntervalMs;

    const clearPing = (): void => {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = undefined;
      }
    };
    const startPing = (socket: WebSocket, intervalMs: number): void => {
      clearPing();
      pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ event: 'ping' }));
        }
      }, intervalMs);
    };

    const scheduleReconnect = (attempt: number): void => {
      if (stopped) return;
      const delayMs = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** attempt);
      this.logger.warn(`AXP WebSocket closed for connector ${connector.id}; reconnecting in ${delayMs}ms`);
      setTimeout(() => {
        if (stopped) return;
        this.provisionAndOpen(baseUrl, accountId, clientId, clientSecret)
          .then(({ socket, pingIntervalMs: nextPingIntervalMs }) => {
            currentSocket = socket;
            attachHandlers(socket, 0);
            startPing(socket, nextPingIntervalMs);
          })
          .catch((err: Error) => {
            this.logger.warn(`AXP reconnect attempt ${attempt} failed: ${err.message}`);
            scheduleReconnect(attempt + 1);
          });
      }, delayMs);
    };

    const attachHandlers = (socket: WebSocket, closeAttempt: number): void => {
      socket.on('message', (raw: RawData) => {
        this.handleMessage(raw, mappings, connector, queue, callbacks);
      });
      socket.on('close', () => {
        clearPing();
        scheduleReconnect(closeAttempt);
      });
      socket.on('error', (err: Error) => {
        this.logger.warn(`AXP WebSocket error for connector ${connector.id}: ${err.message}`);
      });
    };
    attachHandlers(currentSocket, 0);
    startPing(currentSocket, pingIntervalMs);

    return {
      connectorId: connector.id,
      handle: {
        stop: async () => {
          stopped = true;
          clearPing();
          queue.stop();
          currentSocket.close();
        },
      },
    };
  }

  async disconnect(session: StreamingRelaySession): Promise<void> {
    const handle = session.handle as { stop: () => Promise<void> };
    await handle.stop();
  }

  private handleMessage(
    raw: RawData,
    mappings: FieldMapping[],
    connector: IntegrationConnector,
    queue: BackpressureQueue<ActivityEvent>,
    callbacks: StreamingRelayCallbacks,
  ): void {
    let frame: AxpNotificationFrame;
    try {
      frame = JSON.parse(raw.toString()) as AxpNotificationFrame;
    } catch {
      return;
    }
    // `pong` (this adapter's own ping ack) and a late/duplicate
    // `authentication` response frame are real, expected non-event
    // frames - not a parse failure, nothing to count.
    if (frame.event === 'pong' || frame.event === 'authentication') {
      return;
    }
    const body = frame.body;
    // AGENT_ENGAGEMENT carries AgentParticipant/InboundEngagementCreated
    // too (subscribed via `events: ["ALL"]`, filtered client-side here) -
    // only AgentState maps to Module 05's activity-state concept.
    if (!body || body.event !== 'AgentState') {
      return;
    }
    if (!body.agentId || !body.id) {
      // No stable per-event id to build `sourceEventId` from - counted as
      // a failed event rather than silently forwarded without one
      // (Module 05's own dedupe is keyed on it), same posture as
      // GenesysCloudAdapter's missing-`modifiedDate` case.
      callbacks.onEventFailed();
      return;
    }

    const rawRecord: Record<string, unknown> = {
      agentId: body.agentId,
      profileId: body.profileId,
      state: body.state,
      reasonCode: body.reasonCode,
      cause: body.cause,
      // AXP's own `timestamp` is epoch millis, not a string - Module 05's
      // `activityStartedAt` needs a string, so this derives one for the
      // tenant to map from rather than requiring the raw numeric field to
      // pass `hasRequiredActivityFields`'s own string check.
      timestampIso: typeof body.timestamp === 'number' ? new Date(body.timestamp).toISOString() : undefined,
    };
    const transformed = applyFieldMappings(rawRecord, mappings);
    if (!hasRequiredActivityFields(transformed)) {
      callbacks.onEventFailed();
      return;
    }

    const event: ActivityEvent = {
      sourceEventId: `${connector.id}:${body.agentId}:${body.id}`,
      employeeId: transformed.employeeId as string,
      currentActivity: transformed.currentActivity as string,
      activityStartedAt: transformed.activityStartedAt as string,
      siteId: typeof transformed.siteId === 'string' ? transformed.siteId : undefined,
      queueId: typeof transformed.queueId === 'string' ? transformed.queueId : undefined,
    };
    queue.enqueue(event);
  }

  private async provisionAndOpen(
    baseUrl: string,
    accountId: string,
    clientId: string,
    clientSecret: string,
  ): Promise<{ socket: WebSocket; pingIntervalMs: number }> {
    const token = await this.fetchAccessToken(baseUrl, accountId, clientId, clientSecret);
    const subscription = await this.createSubscription(baseUrl, accountId, token);
    const socket = new WebSocket(subscription.endpoint);
    await this.authenticate(socket, subscription.subscriptionId, token);
    return { socket, pingIntervalMs: (subscription.pingIntervalSeconds ?? DEFAULT_PING_INTERVAL_SECONDS) * 1000 };
  }

  private async fetchAccessToken(
    baseUrl: string,
    accountId: string,
    clientId: string,
    clientSecret: string,
  ): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/auth/v1/${accountId}/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`,
      });
    } catch (err) {
      throw new AxpApiError(`token request failed: ${(err as Error).message}`);
    }
    if (!response.ok) {
      throw new AxpApiError(`token request returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as { access_token?: string };
    if (!body.access_token) {
      throw new AxpApiError('token response has no access_token');
    }
    return body.access_token;
  }

  private async createSubscription(
    baseUrl: string,
    accountId: string,
    token: string,
  ): Promise<{ subscriptionId: string; endpoint: string; pingIntervalSeconds?: number }> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/v1/accounts/${accountId}/subscriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ family: 'AGENT_ENGAGEMENT', events: ['ALL'], transport: { type: 'WEBSOCKET' } }),
      });
    } catch (err) {
      throw new AxpApiError(`subscription creation failed: ${(err as Error).message}`);
    }
    if (!response.ok) {
      throw new AxpApiError(`subscription creation returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      subscriptionId?: string;
      transport?: { endpoint?: string };
      pingInterval?: number;
    };
    if (!body.subscriptionId || !body.transport?.endpoint) {
      throw new AxpApiError('subscription response is missing subscriptionId/transport.endpoint');
    }
    return {
      subscriptionId: body.subscriptionId,
      endpoint: body.transport.endpoint,
      pingIntervalSeconds: body.pingInterval,
    };
  }

  private authenticate(socket: WebSocket, subscriptionId: string, token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const onOpen = (): void => {
        socket.send(JSON.stringify({ event: 'authentication', subscriptionId, token }));
      };
      const onMessage = (raw: RawData): void => {
        let frame: { status?: string };
        try {
          frame = JSON.parse(raw.toString()) as { status?: string };
        } catch {
          cleanup();
          reject(new AxpApiError('authentication response was not valid JSON'));
          return;
        }
        cleanup();
        if (frame.status !== 'CONNECTION_CONFIRMED') {
          reject(new AxpApiError(`WebSocket authentication failed: ${frame.status ?? 'no status in response'}`));
          return;
        }
        resolve();
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(new AxpApiError(`WebSocket connection failed: ${err.message}`));
      };
      const cleanup = (): void => {
        socket.off('open', onOpen);
        socket.off('message', onMessage);
        socket.off('error', onError);
      };
      socket.on('open', onOpen);
      socket.once('message', onMessage);
      socket.on('error', onError);
    });
  }
}
