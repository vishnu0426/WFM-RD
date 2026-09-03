import { NotificationChannel } from '../entities/notification-channel.enum';

export interface NotificationDeliveryRequest {
  tenantId: string;
  userId: string;
  channel: NotificationChannel;
  eventType: string;
  payload: Record<string, unknown>;
}

/**
 * GAP-05 fix (enterprise readiness audit, 2026-08-18): the pluggable seam
 * between `NotificationDeliveryDispatcherService` (the retry/observability
 * engine - genuinely real, not a placeholder) and whatever actually sends a
 * message on a given channel. `send` should throw on failure (the
 * dispatcher's own retry/attempts/DLQ-adjacent bookkeeping is what turns a
 * thrown error into a retried or exhausted delivery) and resolve
 * successfully once the message has genuinely left this platform for the
 * channel's transport (or, for `LoggingChannelAdapter`, once it's durably
 * logged - see that class's own doc comment for why that's still an honest
 * "delivered" for local/dev use).
 */
export interface NotificationChannelAdapter {
  readonly channel: NotificationChannel;
  send(request: NotificationDeliveryRequest): Promise<void>;
}

export const NOTIFICATION_CHANNEL_ADAPTERS = Symbol('NOTIFICATION_CHANNEL_ADAPTERS');
