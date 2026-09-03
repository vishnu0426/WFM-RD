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
import { NiceCxoneApiError } from './nice-cxone-api-client.errors';

interface NiceCxoneConnectorConfig {
  niceApiBaseUrl?: string;
  /** ADR-0138/ADR-0141's crosswalk gap restated again: tenant-supplied CXone agent IDs, assumed to already be Module 02 employee UUIDs - no discovery call exists here either. */
  niceAgentIds?: string[];
  credentialReference?: string;
  /** Comet long-poll hold window - research names a documented 0-60s range; defaults conservatively short so a slow/misbehaving fake test server doesn't stall a test suite. */
  longPollHoldSeconds?: number;
  backpressureQueueCapacity?: number;
}

interface NiceCxoneCredential {
  username?: string;
  password?: string;
  clientId?: string;
  clientSecret?: string;
}

interface NiceCxoneEvent {
  agentId?: string;
  eventType?: string;
  state?: string;
  timestamp?: string;
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

const POLL_ERROR_BACKOFF_BASE_MS = 1000;
const POLL_ERROR_BACKOFF_MAX_MS = 30000;
const DEFAULT_LONG_POLL_HOLD_SECONDS = 25;

/**
 * §7 Phase 6b's second streaming adapter. NICE CXone's own documented
 * real-time delivery mechanism is long-polling (`get-next-event`, a
 * comet/reverse-Ajax pattern, 0-60s hold) - `docs/module-12-provider-
 * research.md` names a newer WebSocket Agent SDK too, but with no public
 * shape documented for it, so this adapter builds the one mechanism this
 * platform's research actually sourced. Auth is Resource Owner Password
 * Grant (CXone's own documented "Back-End Apps" pattern, unlike every
 * other researched provider's Client Credentials grant) - `credential`
 * carries `username`/`password` in addition to `clientId`/`clientSecret`.
 *
 * A long-poll *timeout* (no event within the hold window) is the comet
 * pattern's normal, expected outcome - not an error, not a reconnect, not
 * counted anywhere - the loop simply issues the next poll immediately.
 * A genuine HTTP failure applies exponential backoff (capped 30s) before
 * the next poll, the same shape `GenesysCloudAdapter`'s reconnect uses for
 * a closed WebSocket (ADR-0141) - unbounded by design, for the same
 * reason: a permanently broken connector should keep announcing itself,
 * not silently go quiet. `NiceCxoneEvent`'s exact field shape has no
 * vendor-published schema in the research doc's own sources (only that
 * agent-state events exist) - this is a best-effort, reasonably-named
 * shape verified structurally against this module's own fake test double,
 * not a vendor-confirmed contract; a real CXone integration may need this
 * adjusted once a real tenant's actual payload is seen.
 */
@Injectable()
export class NiceCxoneAdapter implements StreamingRelayAdapter {
  private readonly logger = new Logger(NiceCxoneAdapter.name);
  readonly provider = 'NICE CXone';

  constructor(
    private readonly vault: VaultClientService,
    private readonly fieldMappings: FieldMappingsService,
    private readonly intradayClient: IntradayActivityEventClient,
  ) {}

  async connect(connector: IntegrationConnector, callbacks: StreamingRelayCallbacks): Promise<StreamingRelaySession> {
    const config = connector.config as NiceCxoneConnectorConfig;
    const baseUrl = config.niceApiBaseUrl;
    const agentIds = config.niceAgentIds;
    if (!baseUrl || !agentIds || agentIds.length === 0) {
      throw new NiceCxoneApiError('connector.config.niceApiBaseUrl and connector.config.niceAgentIds are required');
    }
    if (!config.credentialReference) {
      throw new NiceCxoneApiError('connector.config.credentialReference is not set');
    }

    const credential = (await this.vault.read(config.credentialReference)) as NiceCxoneCredential;
    const { username, password, clientId, clientSecret } = credential;
    if (!username || !password || !clientId || !clientSecret) {
      throw new NiceCxoneApiError('Vault secret has no username/password/clientId/clientSecret field');
    }

    const holdMs = (config.longPollHoldSeconds ?? DEFAULT_LONG_POLL_HOLD_SECONDS) * 1000;
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
    let accessToken = await this.fetchAccessToken(baseUrl, username, password, clientId, clientSecret);

    const runLoop = async (backoffAttempt: number): Promise<void> => {
      if (stopped) return;
      try {
        await this.pollOnce(baseUrl, accessToken, agentIds, holdMs, connector, mappings, queue);
        void runLoop(0);
      } catch (err) {
        if (stopped) return;
        if (err instanceof NiceCxoneApiError && err.message.includes('HTTP 401')) {
          try {
            accessToken = await this.fetchAccessToken(baseUrl, username, password, clientId, clientSecret);
            void runLoop(0);
            return;
          } catch (reauthErr) {
            this.logger.warn(`NICE CXone re-authentication failed: ${(reauthErr as Error).message}`);
          }
        } else {
          this.logger.warn(`NICE CXone long-poll failed for connector ${connector.id}: ${(err as Error).message}`);
        }
        const delayMs = Math.min(POLL_ERROR_BACKOFF_MAX_MS, POLL_ERROR_BACKOFF_BASE_MS * 2 ** backoffAttempt);
        setTimeout(() => void runLoop(backoffAttempt + 1), delayMs);
      }
    };
    void runLoop(0);

    return {
      connectorId: connector.id,
      handle: {
        stop: async () => {
          stopped = true;
          queue.stop();
        },
      },
    };
  }

  async disconnect(session: StreamingRelaySession): Promise<void> {
    const handle = session.handle as { stop: () => Promise<void> };
    await handle.stop();
  }

  private async pollOnce(
    baseUrl: string,
    accessToken: string,
    agentIds: string[],
    holdMs: number,
    connector: IntegrationConnector,
    mappings: FieldMapping[],
    queue: BackpressureQueue<ActivityEvent>,
  ): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), holdMs);
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/get-next-event?agentIds=${agentIds.join(',')}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        // A real long-poll timeout - no event within the hold window,
        // the comet pattern's own normal outcome, not a failure.
        return;
      }
      throw new NiceCxoneApiError((err as Error).message);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new NiceCxoneApiError(`HTTP ${response.status}`);
    }
    const body = (await response.json()) as { events?: NiceCxoneEvent[] };
    for (const event of body.events ?? []) {
      this.handleEvent(event, connector, mappings, queue);
    }
  }

  private handleEvent(
    event: NiceCxoneEvent,
    connector: IntegrationConnector,
    mappings: FieldMapping[],
    queue: BackpressureQueue<ActivityEvent>,
  ): void {
    if (!event.agentId || !event.timestamp) {
      return;
    }
    const rawRecord: Record<string, unknown> = {
      agentId: event.agentId,
      state: event.state,
      timestamp: event.timestamp,
    };
    const transformed = applyFieldMappings(rawRecord, mappings);
    if (!hasRequiredActivityFields(transformed)) {
      return;
    }
    const activityEvent: ActivityEvent = {
      sourceEventId: `${connector.id}:${event.agentId}:${event.timestamp}`,
      employeeId: transformed.employeeId as string,
      currentActivity: transformed.currentActivity as string,
      activityStartedAt: transformed.activityStartedAt as string,
      siteId: typeof transformed.siteId === 'string' ? transformed.siteId : undefined,
      queueId: typeof transformed.queueId === 'string' ? transformed.queueId : undefined,
    };
    queue.enqueue(activityEvent);
  }

  private async fetchAccessToken(
    baseUrl: string,
    username: string,
    password: string,
    clientId: string,
    clientSecret: string,
  ): Promise<string> {
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/token/oauth2`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `grant_type=password&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
      });
    } catch (err) {
      throw new NiceCxoneApiError(`token request failed: ${(err as Error).message}`);
    }
    if (!response.ok) {
      throw new NiceCxoneApiError(`token request returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as { access_token?: string };
    if (!body.access_token) {
      throw new NiceCxoneApiError('token response has no access_token');
    }
    return body.access_token;
  }
}
