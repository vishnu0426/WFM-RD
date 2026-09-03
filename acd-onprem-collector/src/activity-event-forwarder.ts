import { createHmac } from "node:crypto";

/** Wire shape of `intraday-service`'s `ActivityEventDto` (`intraday-service/src/ingestion/dto/activity-event.dto.ts`) - kept in sync by hand, same cross-service-coupling posture every other adapter/payload interface in this platform already accepts. */
export interface ActivityEvent {
  sourceEventId: string;
  employeeId: string;
  currentActivity: string;
  activityStartedAt: string;
  siteId?: string;
  queueId?: string;
}

export type ForwardOutcome = "accepted" | "duplicate";

export class ActivityEventForwardError extends Error {
  /** `undefined` for a network-level failure (no response at all); a real HTTP status for anything the ingestion endpoint itself returned. */
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ActivityEventForwardError";
  }
}

const SIGNATURE_HEADER = "x-agno-webhook-signature";

/**
 * Signs and POSTs one activity event to intraday-service's ingestion
 * endpoint (`intraday-service/src/ingestion/ingestion.controller.ts`),
 * using the exact `t=<unix_ms>,v1=<hex hmac>` scheme
 * `HmacSignatureGuard` verifies on the other end:
 * `HMAC-SHA256(secret, "${timestamp}.${rawBody}")`. This is the only
 * network call this collector ever makes outward to our platform - one
 * outbound HTTPS POST per event, no persistent connection, no inbound
 * port opened on the customer's side.
 */
export class ActivityEventForwarder {
  constructor(
    private readonly ingestionBaseUrl: string,
    private readonly tenantId: string,
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async forward(event: ActivityEvent): Promise<ForwardOutcome> {
    const body = JSON.stringify(event);
    const timestamp = Date.now();
    const signature = createHmac("sha256", this.secret)
      .update(`${timestamp}.${body}`)
      .digest("hex");
    const url = `${this.ingestionBaseUrl}/v1/intraday/tenants/${this.tenantId}/activity-events`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SIGNATURE_HEADER]: `t=${timestamp},v1=${signature}`,
        },
        body,
      });
    } catch (err) {
      throw new ActivityEventForwardError(
        `network error forwarding event ${event.sourceEventId}: ${(err as Error).message}`,
      );
    }

    if (response.status === 202) return "accepted";
    if (response.status === 200) return "duplicate";
    throw new ActivityEventForwardError(
      `ingestion endpoint returned ${response.status} for event ${event.sourceEventId}`,
      response.status,
    );
  }
}
