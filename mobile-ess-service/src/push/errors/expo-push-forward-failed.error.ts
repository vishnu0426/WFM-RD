/**
 * A transient/infra failure calling Expo's push-send API - unreachable,
 * a non-2xx HTTP status from the API itself, or an unreadable/malformed
 * response body. Distinct from a per-message delivery outcome
 * (`ExpoPushSendResult.errorType`, e.g. `DeviceNotRegistered`) - Expo
 * returns HTTP 200 with a per-ticket `status` even when an individual
 * message fails to deliver, so THAT case is a normal return value, not
 * this error. `PushDispatchService` lets this one propagate (unlike a
 * permanent per-device outcome) so the NATS consumer naks the message for
 * redelivery (ADR-0154 §B2).
 */
export class ExpoPushForwardFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpoPushForwardFailedError';
  }
}
