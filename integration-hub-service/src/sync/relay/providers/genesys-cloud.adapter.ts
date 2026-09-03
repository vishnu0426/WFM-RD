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
import { GenesysApiError } from './genesys-api-client.errors';

interface GenesysConnectorConfig {
  genesysApiBaseUrl?: string;
  /**
   * ADR-0138's crosswalk gap, restated for streaming: Genesys Cloud user
   * IDs are opaque to this module - there is no discovery call this
   * adapter makes to enumerate "every agent," and no ID-crosswalk table
   * anywhere in this schema. The tenant supplies the exact set of Genesys
   * user IDs to subscribe presence for, the same "source IDs must already
   * align with Module 02's own identifiers" posture ADR-0138 already
   * accepted for batch `employeeNumber`.
   */
  genesysUserIds?: string[];
  credentialReference?: string;
  backpressureQueueCapacity?: number;
}

interface GenesysCredential {
  clientId?: string;
  clientSecret?: string;
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

/**
 * §7 Phase 6's reference `StreamingRelayAdapter` (ADR-0141). Genesys
 * Cloud's real-time surface is the Notifications API (research doc's
 * Genesys Cloud section) - not a webhook - so "connect" here is the real,
 * three-call provisioning dance every Genesys integration must do before
 * a WebSocket exists at all: OAuth2 client-credentials token, then
 * `POST /api/v2/notifications/channels` (returns `connectUri`), then
 * `PUT .../subscriptions` naming each `v2.users.{id}.presence` topic. This
 * environment has no real, credentialed Genesys Cloud org, so verification
 * runs against a real local server that speaks this exact three-call
 * shape plus a real WebSocket upgrade - see the Phase 6 design doc.
 *
 * A closed/expired channel is not resumable - Genesys's own model requires
 * re-provisioning a new channel, not just reopening a socket - so an
 * unexpected `close` re-runs the full dance with exponential backoff
 * rather than a bare WebSocket reconnect. The initial `connect()` call
 * itself does not swallow failures: a structural problem (bad config, no
 * credential, provider rejects the request) fails the `SyncJob` atomically
 * via `StreamingRelayService`'s own `adapter_connect_threw` path, matching
 * `WorkdayAdapter`'s posture of not silently retrying a config error.
 */
@Injectable()
export class GenesysCloudAdapter implements StreamingRelayAdapter {
  private readonly logger = new Logger(GenesysCloudAdapter.name);
  readonly provider = 'Genesys Cloud';

  constructor(
    private readonly vault: VaultClientService,
    private readonly fieldMappings: FieldMappingsService,
    private readonly intradayClient: IntradayActivityEventClient,
  ) {}

  async connect(connector: IntegrationConnector, callbacks: StreamingRelayCallbacks): Promise<StreamingRelaySession> {
    const config = connector.config as GenesysConnectorConfig;
    const baseUrl = config.genesysApiBaseUrl;
    const userIds = config.genesysUserIds;
    if (!baseUrl || !userIds || userIds.length === 0) {
      throw new GenesysApiError('connector.config.genesysApiBaseUrl and connector.config.genesysUserIds are required');
    }
    if (!config.credentialReference) {
      throw new GenesysApiError('connector.config.credentialReference is not set');
    }

    const credential = (await this.vault.read(config.credentialReference)) as GenesysCredential;
    const clientId = credential.clientId;
    const clientSecret = credential.clientSecret;
    if (!clientId || !clientSecret) {
      throw new GenesysApiError('Vault secret has no clientId/clientSecret field');
    }

    const mappings = await this.fieldMappings.findAllForConnector(connector.tenantId, connector.id);

    const queue = new BackpressureQueue<ActivityEvent>({
      capacity: config.backpressureQueueCapacity ?? 1000,
      process: async (event) => {
        try {
          const result = await this.intradayClient.forward(connector.tenantId, event);
          // A `duplicate` result means Module 05 already counted this exact
          // `sourceEventId` in an earlier window (a real, expected outcome
          // on a WS reconnect retransmit) - counting it again here would
          // double-count against this job's own `records_processed`
          // (§2.1: "events forwarded in the window"), so only a genuine
          // new acceptance increments it.
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
    let currentSocket = await this.provisionAndOpen(baseUrl, clientId, clientSecret, userIds);

    const scheduleReconnect = (attempt: number): void => {
      if (stopped) return;
      const delayMs = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** attempt);
      this.logger.warn(`Genesys Cloud WebSocket closed for connector ${connector.id}; reconnecting in ${delayMs}ms`);
      setTimeout(() => {
        if (stopped) return;
        this.provisionAndOpen(baseUrl, clientId, clientSecret, userIds)
          .then((socket) => {
            currentSocket = socket;
            attachHandlers(socket, 0);
          })
          .catch((err: Error) => {
            this.logger.warn(`Genesys Cloud reconnect attempt ${attempt} failed: ${err.message}`);
            scheduleReconnect(attempt + 1);
          });
      }, delayMs);
    };

    const attachHandlers = (socket: WebSocket, closeAttempt: number): void => {
      socket.on('message', (raw: RawData) => {
        this.handleMessage(raw, mappings, connector, queue, callbacks);
      });
      socket.on('close', () => scheduleReconnect(closeAttempt));
      socket.on('error', (err: Error) => {
        this.logger.warn(`Genesys Cloud WebSocket error for connector ${connector.id}: ${err.message}`);
      });
    };
    attachHandlers(currentSocket, 0);

    return {
      connectorId: connector.id,
      handle: {
        stop: async () => {
          stopped = true;
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
    let frame: { topicName?: string; eventBody?: Record<string, unknown> };
    try {
      frame = JSON.parse(raw.toString()) as { topicName?: string; eventBody?: Record<string, unknown> };
    } catch {
      // Not real event data (malformed frame) - nothing to count a failure against.
      return;
    }
    // Genesys sends a periodic `channel.metadata` heartbeat frame on every
    // open channel, with no `eventBody` - a real, documented, expected
    // non-event frame, not a parse failure.
    if (!frame.topicName || frame.topicName === 'channel.metadata' || !frame.eventBody) {
      return;
    }
    const match = /^v2\.users\.([^.]+)\.presence$/.exec(frame.topicName);
    if (!match) {
      return;
    }
    const userId = match[1];
    const eventBody = frame.eventBody;
    const modifiedDate = eventBody.modifiedDate;
    if (typeof modifiedDate !== 'string') {
      // No idempotency key to build a stable `sourceEventId` from -
      // counted as a failed event rather than silently forwarded
      // without one (Module 05's own dedupe is keyed on it).
      callbacks.onEventFailed();
      return;
    }

    const rawRecord: Record<string, unknown> = { userId, ...eventBody };
    const transformed = applyFieldMappings(rawRecord, mappings);
    if (!hasRequiredActivityFields(transformed)) {
      callbacks.onEventFailed();
      return;
    }

    const event: ActivityEvent = {
      sourceEventId: `${connector.id}:${userId}:${modifiedDate}`,
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
    clientId: string,
    clientSecret: string,
    userIds: string[],
  ): Promise<WebSocket> {
    const token = await this.fetchAccessToken(baseUrl, clientId, clientSecret);
    const channel = await this.createChannel(baseUrl, token);
    await this.subscribeChannel(baseUrl, token, channel.id, userIds);
    return new WebSocket(channel.connectUri);
  }

  private async fetchAccessToken(baseUrl: string, clientId: string, clientSecret: string): Promise<string> {
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/oauth/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      });
    } catch (err) {
      throw new GenesysApiError(`token request failed: ${(err as Error).message}`);
    }
    if (!response.ok) {
      throw new GenesysApiError(`token request returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as { access_token?: string };
    if (!body.access_token) {
      throw new GenesysApiError('token response has no access_token');
    }
    return body.access_token;
  }

  private async createChannel(baseUrl: string, token: string): Promise<{ id: string; connectUri: string }> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/v2/notifications/channels`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      throw new GenesysApiError(`channel creation failed: ${(err as Error).message}`);
    }
    if (!response.ok) {
      throw new GenesysApiError(`channel creation returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as { id?: string; connectUri?: string };
    if (!body.id || !body.connectUri) {
      throw new GenesysApiError('channel response is missing id/connectUri');
    }
    return { id: body.id, connectUri: body.connectUri };
  }

  private async subscribeChannel(baseUrl: string, token: string, channelId: string, userIds: string[]): Promise<void> {
    const topics = userIds.map((userId) => ({ id: `v2.users.${userId}.presence` }));
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/v2/notifications/channels/${channelId}/subscriptions`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(topics),
      });
    } catch (err) {
      throw new GenesysApiError(`subscription failed: ${(err as Error).message}`);
    }
    if (!response.ok) {
      throw new GenesysApiError(`subscription returned HTTP ${response.status}`);
    }
  }
}
