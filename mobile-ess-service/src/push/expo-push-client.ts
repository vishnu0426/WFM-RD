import { Injectable } from '@nestjs/common';
import { ExpoPushForwardFailedError } from './errors/expo-push-forward-failed.error';

export interface ExpoPushMessage {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface ExpoPushSendResult {
  ok: boolean;
  /** Expo's own documented enum: DeviceNotRegistered/MessageTooBig/
   * MessageRateExceeded/InvalidCredentials/etc. Only present when `ok` is false. */
  errorType?: string;
}

interface ExpoPushTicket {
  status: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
}

/**
 * Plain HTTPS POST to Expo's push-send API (ADR-0154, Expo managed
 * workflow - no APNs/FCM credentials needed on this service).
 *
 * Same transport-level discipline as `LeaveRequestClient`/
 * `MarketplaceClaimClient` (Phase 4): never trusts bare `response.ok` to
 * mean "the message was delivered" - Expo returns HTTP 200 with a
 * per-message `data[]` array where each entry independently carries
 * `status: 'ok' | 'error'`. `response.ok` is still checked, but only for
 * genuine API-level failure (malformed request, Expo's own API down) -
 * distinct from a per-message delivery outcome, which is always read from
 * the parsed ticket, never inferred from the HTTP status.
 */
@Injectable()
export class ExpoPushClient {
  private readonly apiUrl = process.env.EXPO_PUSH_API_URL ?? 'https://exp.host/--/api/v2/push/send';

  async send(pushToken: string, message: ExpoPushMessage): Promise<ExpoPushSendResult> {
    let response: Response;
    try {
      response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ to: pushToken, title: message.title, body: message.body, data: message.data }),
      });
    } catch (err) {
      throw new ExpoPushForwardFailedError(`Expo push API unreachable: ${(err as Error).message}`);
    }

    const body = await this.safeJson(response);
    if (!response.ok || !body) {
      throw new ExpoPushForwardFailedError(
        `HTTP ${response.status}: ${body ? JSON.stringify(body) : 'unreadable body'}`,
      );
    }

    const ticket = body.data?.[0];
    if (!ticket) {
      throw new ExpoPushForwardFailedError('Expo push API returned no ticket for the sent message');
    }

    if (ticket.status === 'ok') {
      return { ok: true };
    }
    return { ok: false, errorType: ticket.details?.error };
  }

  private async safeJson(response: Response): Promise<{ data?: ExpoPushTicket[] } | null> {
    try {
      return (await response.json()) as { data?: ExpoPushTicket[] };
    } catch {
      return null;
    }
  }
}
