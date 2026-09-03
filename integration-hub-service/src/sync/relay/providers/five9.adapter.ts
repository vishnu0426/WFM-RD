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
import { Five9ApiError } from './five9-api-client.errors';

interface Five9ConnectorConfig {
  five9ApiBaseUrl?: string;
  credentialReference?: string;
  backpressureQueueCapacity?: number;
}

interface Five9Credential {
  username?: string;
  password?: string;
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
 * §7 Phase 6b's third streaming adapter. Five9's real-time surface
 * (`docs/module-12-provider-research.md`) is session-based: authenticate
 * to get session metadata, then open a WebSocket carrying that session -
 * simpler than Genesys Cloud's own channel/topic-subscription dance
 * (ADR-0141), but the same "terminate the provider's real transport, not
 * a generic webhook" posture. Five9's rate limit is fully undocumented by
 * the vendor for this surface (research doc: `is_published: false`,
 * constrained in practice by licensed WebSocket seat count) - nothing in
 * this adapter throttles the initial authenticate call, matching that
 * disclosed absence rather than inventing an unsourced number.
 *
 * `Five9AgentStateEvent`'s exact wire shape has no vendor-published schema
 * in the research doc's sources either (only that the WebSocket carries
 * real-time agent events) - the same disclosed-best-effort posture as
 * `NiceCxoneAdapter`'s own event shape, verified structurally against
 * this module's own fake test double, not a vendor-confirmed contract.
 *
 * A closed WebSocket re-runs the full authenticate-then-connect dance
 * with unbounded exponential backoff (capped 30s) - Five9 sessions are
 * assumed non-resumable across a socket close, the same conservative
 * assumption ADR-0141 makes for Genesys Cloud's own channels, absent any
 * research finding that says otherwise.
 */
@Injectable()
export class Five9Adapter implements StreamingRelayAdapter {
  private readonly logger = new Logger(Five9Adapter.name);
  readonly provider = 'Five9';

  constructor(
    private readonly vault: VaultClientService,
    private readonly fieldMappings: FieldMappingsService,
    private readonly intradayClient: IntradayActivityEventClient,
  ) {}

  async connect(connector: IntegrationConnector, callbacks: StreamingRelayCallbacks): Promise<StreamingRelaySession> {
    const config = connector.config as Five9ConnectorConfig;
    const baseUrl = config.five9ApiBaseUrl;
    if (!baseUrl) {
      throw new Five9ApiError('connector.config.five9ApiBaseUrl is required');
    }
    if (!config.credentialReference) {
      throw new Five9ApiError('connector.config.credentialReference is not set');
    }

    const credential = (await this.vault.read(config.credentialReference)) as Five9Credential;
    const { username, password } = credential;
    if (!username || !password) {
      throw new Five9ApiError('Vault secret has no username/password field');
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
    let currentSocket = await this.authenticateAndOpen(baseUrl, username, password);

    const scheduleReconnect = (attempt: number): void => {
      if (stopped) return;
      const delayMs = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** attempt);
      this.logger.warn(`Five9 WebSocket closed for connector ${connector.id}; reconnecting in ${delayMs}ms`);
      setTimeout(() => {
        if (stopped) return;
        this.authenticateAndOpen(baseUrl, username, password)
          .then((socket) => {
            currentSocket = socket;
            attachHandlers(socket, 0);
          })
          .catch((err: Error) => {
            this.logger.warn(`Five9 reconnect attempt ${attempt} failed: ${err.message}`);
            scheduleReconnect(attempt + 1);
          });
      }, delayMs);
    };

    const attachHandlers = (socket: WebSocket, closeAttempt: number): void => {
      socket.on('message', (raw: RawData) => {
        this.handleMessage(raw, mappings, connector, queue);
      });
      socket.on('close', () => scheduleReconnect(closeAttempt));
      socket.on('error', (err: Error) => {
        this.logger.warn(`Five9 WebSocket error for connector ${connector.id}: ${err.message}`);
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
  ): void {
    let frame: { type?: string; agentId?: string; state?: string; occurredAt?: string };
    try {
      frame = JSON.parse(raw.toString()) as { type?: string; agentId?: string; state?: string; occurredAt?: string };
    } catch {
      return;
    }
    if (frame.type !== 'AgentStateChanged' || !frame.agentId || !frame.occurredAt) {
      return;
    }

    const rawRecord: Record<string, unknown> = {
      agentId: frame.agentId,
      state: frame.state,
      occurredAt: frame.occurredAt,
    };
    const transformed = applyFieldMappings(rawRecord, mappings);
    if (!hasRequiredActivityFields(transformed)) {
      return;
    }

    const event: ActivityEvent = {
      sourceEventId: `${connector.id}:${frame.agentId}:${frame.occurredAt}`,
      employeeId: transformed.employeeId as string,
      currentActivity: transformed.currentActivity as string,
      activityStartedAt: transformed.activityStartedAt as string,
      siteId: typeof transformed.siteId === 'string' ? transformed.siteId : undefined,
      queueId: typeof transformed.queueId === 'string' ? transformed.queueId : undefined,
    };
    queue.enqueue(event);
  }

  private async authenticateAndOpen(baseUrl: string, username: string, password: string): Promise<WebSocket> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/authenticate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
    } catch (err) {
      throw new Five9ApiError(`authenticate request failed: ${(err as Error).message}`);
    }
    if (!response.ok) {
      throw new Five9ApiError(`authenticate request returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as { sessionId?: string; webSocketUri?: string };
    if (!body.sessionId || !body.webSocketUri) {
      throw new Five9ApiError('authenticate response is missing sessionId/webSocketUri');
    }
    return new WebSocket(body.webSocketUri, { headers: { 'x-five9-session-id': body.sessionId } });
  }
}
