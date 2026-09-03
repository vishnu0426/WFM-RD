import { Injectable } from '@nestjs/common';
import { createHmac } from 'crypto';
import {
  IntradayForwardFailedError,
  IntradayHmacSecretNotConfiguredError,
  IntradayUpstreamDegradedError,
} from '../../errors/intraday-forwarding.errors';

export interface ActivityEvent {
  sourceEventId: string;
  employeeId: string;
  currentActivity: string;
  activityStartedAt: string;
  siteId?: string;
  queueId?: string;
}

export interface ActivityEventResult {
  status: 'accepted' | 'duplicate';
  sourceEventId: string;
}

/**
 * §0/§2.2 rule 3b: the real, sanctioned write path for streaming (acd)
 * connectors - Module 05's own real, already-built
 * `POST /v1/intraday/tenants/:tenantId/activity-events`
 * (`intraday-service/src/ingestion/ingestion.controller.ts`), never a
 * direct write to `AgentLiveState`/Redis.
 *
 * Two real facts this client's shape is built around, both confirmed live
 * against the actual running service, not assumed from reading its source:
 * - `tenantId` is a URL path segment, not a header - unlike every other
 *   cross-module call this platform makes.
 * - The endpoint's real auth *is* `HmacSignatureGuard` - header
 *   `x-agno-webhook-signature: t=<unix_ms>,v1=<hex>`, HMAC-SHA256 over
 *   `${timestamp}.${rawBody}` with a shared secret. Module 12 is the party
 *   Module 05 authenticates here - it doesn't matter to Module 05 whether
 *   the event originated from a real webhook or, as for Genesys Cloud, a
 *   WebSocket session this module's own relay terminated (ADR-0141).
 *
 * `IntradayUpstreamDegradedError` (real HTTP 503, Module 05's own
 * `UpstreamUnavailableError`) is the actual degradation signal §5a's
 * backpressure guard reacts to - distinct from
 * `IntradayForwardFailedError` (Module 05 rejected the event body itself,
 * a genuine per-event failure, not upstream degradation).
 */
@Injectable()
export class IntradayActivityEventClient {
  private readonly baseUrl = process.env.INTRADAY_SERVICE_URL ?? 'http://localhost:8200';
  private readonly secrets: Record<string, string> = JSON.parse(process.env.INTRADAY_INGESTION_HMAC_SECRETS ?? '{}');

  async forward(tenantId: string, event: ActivityEvent): Promise<ActivityEventResult> {
    const secret = this.secrets[tenantId];
    if (!secret) {
      throw new IntradayHmacSecretNotConfiguredError(tenantId);
    }

    const body = JSON.stringify(event);
    const timestamp = Date.now();
    const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/intraday/tenants/${tenantId}/activity-events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-agno-webhook-signature': `t=${timestamp},v1=${signature}`,
        },
        body,
      });
    } catch (err) {
      throw new IntradayUpstreamDegradedError((err as Error).message);
    }

    if (response.status === 503) {
      throw new IntradayUpstreamDegradedError(`HTTP 503: ${await this.safeBody(response)}`);
    }
    if (!response.ok) {
      throw new IntradayForwardFailedError(`HTTP ${response.status}: ${await this.safeBody(response)}`);
    }
    return (await response.json()) as ActivityEventResult;
  }

  private async safeBody(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return '<unreadable body>';
    }
  }
}
