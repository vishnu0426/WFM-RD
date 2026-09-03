import { Injectable, Logger } from '@nestjs/common';
import { VaultClientService } from '../../../vault/vault-client.service';
import { FieldMappingsService } from '../../../connectors/field-mappings.service';
import { FieldMapping } from '../../../integrations/entities/field-mapping.entity';
import { applyFieldMappings } from '../../batch/providers/field-mapping-transform';
import { IntegrationConnector } from '../../../integrations/entities/integration-connector.entity';
import { StreamingRelayAdapter, StreamingRelayCallbacks, StreamingRelaySession } from '../streaming-relay-adapter';
import { BackpressureQueue } from './backpressure-queue';
import { ActivityEvent, IntradayActivityEventClient } from './intraday-activity-event-client';
import { IntradayUpstreamDegradedError } from '../../errors/intraday-forwarding.errors';
import { TalkdeskApiError } from './talkdesk-api-client.errors';

interface TalkdeskConnectorConfig {
  talkdeskApiBaseUrl?: string;
  credentialReference?: string;
  backpressureQueueCapacity?: number;
}

interface TalkdeskCredential {
  clientId?: string;
  clientSecret?: string;
}

/** Talkdesk's own documented ≤16-metrics-per-subscription cap (research doc) - this adapter only ever needs agent status, well under it. */
const LIVE_API_METRICS = ['agent_status'];

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
 * §7 Phase 6b's fourth streaming adapter, and the first to terminate
 * Server-Sent Events rather than a WebSocket - Talkdesk's real-time agent
 * surface is its Live API: subscribe to up to 16 metrics, then hold an SSE
 * connection updated every 5-60s (`docs/module-12-provider-research.md`;
 * Talkdesk's separate Events/Webhook Trigger API is real but its catalog
 * is app-lifecycle-only, not agent status - not the mechanism this
 * adapter needs). No `EventSource` global exists in Node - SSE here is
 * plain chunked-HTTP text parsing over `fetch`'s own `response.body`
 * stream, splitting on the SSE frame delimiter (a blank line) and reading
 * `data:` lines, the actual SSE wire format, not a library abstraction
 * over it.
 *
 * The subscribe-then-stream shape mirrors Genesys Cloud's own two-call
 * provisioning dance (ADR-0141) in spirit - `POST .../subscriptions` then
 * `GET` the resulting stream - even though the transport underneath
 * differs. A stream that ends (server closes it, or a genuine fetch
 * failure) re-runs the full authenticate-subscribe-stream dance with
 * unbounded exponential backoff (capped 30s), the same posture as every
 * other streaming adapter's reconnect in this module.
 */
@Injectable()
export class TalkdeskAdapter implements StreamingRelayAdapter {
  private readonly logger = new Logger(TalkdeskAdapter.name);
  readonly provider = 'Talkdesk';

  constructor(
    private readonly vault: VaultClientService,
    private readonly fieldMappings: FieldMappingsService,
    private readonly intradayClient: IntradayActivityEventClient,
  ) {}

  async connect(connector: IntegrationConnector, callbacks: StreamingRelayCallbacks): Promise<StreamingRelaySession> {
    const config = connector.config as TalkdeskConnectorConfig;
    const baseUrl = config.talkdeskApiBaseUrl;
    if (!baseUrl) {
      throw new TalkdeskApiError('connector.config.talkdeskApiBaseUrl is required');
    }
    if (!config.credentialReference) {
      throw new TalkdeskApiError('connector.config.credentialReference is not set');
    }

    const credential = (await this.vault.read(config.credentialReference)) as TalkdeskCredential;
    const { clientId, clientSecret } = credential;
    if (!clientId || !clientSecret) {
      throw new TalkdeskApiError('Vault secret has no clientId/clientSecret field');
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
    let currentAbortController: AbortController | undefined;

    const runStream = async (attempt: number): Promise<void> => {
      if (stopped) return;
      try {
        const token = await this.fetchAccessToken(baseUrl, clientId, clientSecret);
        const subscriptionId = await this.subscribe(baseUrl, token);
        currentAbortController = new AbortController();
        await this.streamEvents(baseUrl, token, subscriptionId, currentAbortController.signal, (raw) =>
          this.handleSseFrame(raw, mappings, connector, queue),
        );
        // The stream ended (server closed it) rather than throwing - a
        // real, expected outcome (Talkdesk's own subscription lifetime is
        // finite), not a failure - reconnect immediately, no backoff.
        if (!stopped) void runStream(0);
      } catch (err) {
        if (stopped) return;
        this.logger.warn(`Talkdesk stream failed for connector ${connector.id}: ${(err as Error).message}`);
        const delayMs = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** attempt);
        setTimeout(() => void runStream(attempt + 1), delayMs);
      }
    };
    void runStream(0);

    return {
      connectorId: connector.id,
      handle: {
        stop: async () => {
          stopped = true;
          queue.stop();
          currentAbortController?.abort();
        },
      },
    };
  }

  async disconnect(session: StreamingRelaySession): Promise<void> {
    const handle = session.handle as { stop: () => Promise<void> };
    await handle.stop();
  }

  private handleSseFrame(
    rawFrame: string,
    mappings: FieldMapping[],
    connector: IntegrationConnector,
    queue: BackpressureQueue<ActivityEvent>,
  ): void {
    const dataLines = rawFrame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim());
    if (dataLines.length === 0) {
      return;
    }
    let payload: { agentId?: string; status?: string; updatedAt?: string };
    try {
      payload = JSON.parse(dataLines.join('')) as { agentId?: string; status?: string; updatedAt?: string };
    } catch {
      return;
    }
    if (!payload.agentId || !payload.updatedAt) {
      return;
    }

    const rawRecord: Record<string, unknown> = {
      agentId: payload.agentId,
      status: payload.status,
      updatedAt: payload.updatedAt,
    };
    const transformed = applyFieldMappings(rawRecord, mappings);
    if (!hasRequiredActivityFields(transformed)) {
      return;
    }

    const event: ActivityEvent = {
      sourceEventId: `${connector.id}:${payload.agentId}:${payload.updatedAt}`,
      employeeId: transformed.employeeId as string,
      currentActivity: transformed.currentActivity as string,
      activityStartedAt: transformed.activityStartedAt as string,
      siteId: typeof transformed.siteId === 'string' ? transformed.siteId : undefined,
      queueId: typeof transformed.queueId === 'string' ? transformed.queueId : undefined,
    };
    queue.enqueue(event);
  }

  private async streamEvents(
    baseUrl: string,
    token: string,
    subscriptionId: string,
    signal: AbortSignal,
    onFrame: (rawFrame: string) => void,
  ): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/live-data/subscriptions/${subscriptionId}/stream`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
        signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      throw new TalkdeskApiError(`stream request failed: ${(err as Error).message}`);
    }
    if (!response.ok || !response.body) {
      throw new TalkdeskApiError(`stream request returned HTTP ${response.status}`);
    }

    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let delimiterIndex: number;
        while ((delimiterIndex = buffer.indexOf('\n\n')) !== -1) {
          const rawFrame = buffer.slice(0, delimiterIndex);
          buffer = buffer.slice(delimiterIndex + 2);
          onFrame(rawFrame);
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      throw new TalkdeskApiError(`stream read failed: ${(err as Error).message}`);
    }
  }

  private async subscribe(baseUrl: string, token: string): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/live-data/subscriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ metrics: LIVE_API_METRICS }),
      });
    } catch (err) {
      throw new TalkdeskApiError(`subscribe request failed: ${(err as Error).message}`);
    }
    if (!response.ok) {
      throw new TalkdeskApiError(`subscribe request returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as { subscriptionId?: string };
    if (!body.subscriptionId) {
      throw new TalkdeskApiError('subscribe response is missing subscriptionId');
    }
    return body.subscriptionId;
  }

  private async fetchAccessToken(baseUrl: string, clientId: string, clientSecret: string): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
      });
    } catch (err) {
      throw new TalkdeskApiError(`token request failed: ${(err as Error).message}`);
    }
    if (!response.ok) {
      throw new TalkdeskApiError(`token request returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as { access_token?: string };
    if (!body.access_token) {
      throw new TalkdeskApiError('token response has no access_token');
    }
    return body.access_token;
  }
}
