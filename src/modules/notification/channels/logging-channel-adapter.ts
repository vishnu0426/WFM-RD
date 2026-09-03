import { Injectable, Logger } from '@nestjs/common';
import { NotificationChannel } from '../entities/notification-channel.enum';
import { NotificationChannelAdapter, NotificationDeliveryRequest } from './notification-channel-adapter';

/**
 * GAP-05 fix (enterprise readiness audit, 2026-08-18): the one concrete
 * `NotificationChannelAdapter` this repository ships with today. This
 * platform has no email/SMS/push provider credentials configured anywhere
 * (no SendGrid/Twilio/Expo-push keys in any `.env.example`) - rather than
 * fabricate a fake integration with a real-sounding vendor name, this
 * adapter is an honest, disclosed placeholder: it durably logs every
 * notification that would have been sent, on every channel, so the
 * dispatch/retry/observability engine around it (real: claim-safe queue,
 * retry with backoff via attempts tracking, metrics) is fully exercised and
 * testable today. Swapping in a real provider later is a matter of adding a
 * new `NotificationChannelAdapter` implementation per channel and
 * registering it in `NotificationModule` - this class, and the interface it
 * implements, are the seam that makes that a small, additive change rather
 * than a rewrite.
 *
 * Registered for all four channels rather than one adapter per channel
 * today (`email`/`sms`/`push`/`in_app` all resolve here) - see
 * `NotificationModule`'s own doc comment for how a real provider replaces
 * this per-channel.
 */
@Injectable()
export class LoggingChannelAdapter implements NotificationChannelAdapter {
  private readonly logger = new Logger(LoggingChannelAdapter.name);

  constructor(readonly channel: NotificationChannel) {}

  async send(request: NotificationDeliveryRequest): Promise<void> {
    this.logger.log(
      `[placeholder ${this.channel} delivery] tenant=${request.tenantId} user=${request.userId} eventType=${request.eventType} payload=${JSON.stringify(request.payload)}`,
    );
  }
}
