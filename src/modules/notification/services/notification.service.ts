import { Injectable, Logger } from '@nestjs/common';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { NotificationPreferencesRepository } from '../repositories/notification-preferences.repository';
import { NotificationDeliveryRepository } from '../repositories/notification-delivery.repository';
import { NotificationRulesRepository } from '../repositories/notification-rules.repository';
import { NotificationChannel } from '../entities/notification-channel.enum';

/**
 * GAP-05 fix (enterprise readiness audit, 2026-08-18): the write side of
 * this platform's first real notification delivery engine -
 * `core.notification_preferences` (who wants what, on which channel) has
 * existed since Phase 1 with nothing ever reading it; `NotificationDeliveryDispatcherService`
 * is the read/send side.
 *
 * Requires an ambient tenant context (`TenantContextService`), same
 * convention as `NotificationPreferencesRepository` itself - callers must
 * already be inside a `tenantContext.run({ tenantId }, ...)` block (e.g.
 * `SkillDecayJobService.runForTenant` already is).
 *
 * Deliberately does not depend on `MetricsService` - same "leaf module
 * exposes a queryable count, MetricsModule pulls it" convention every other
 * queue in this codebase already follows (`CoreOutboxEventsRepository.countUnpublished`,
 * `WebhookDeliveriesRepository.countPending`), not a direct Counter.inc()
 * call - `NotificationModule` importing `MetricsModule` while `MetricsModule`
 * imports `NotificationModule` for the gauge would be a real dependency
 * cycle Nest can't resolve.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly preferencesRepository: NotificationPreferencesRepository,
    private readonly deliveryRepository: NotificationDeliveryRepository,
    private readonly rulesRepository: NotificationRulesRepository,
  ) {}

  /**
   * Fans out to one `notification_delivery` row per channel enabled for
   * `eventType` — a user's own explicit `NotificationPreference` row for a
   * channel always wins (`core.notification_preferences` is still per-user
   * self-service); for a channel the user has NO preference row for, the
   * tenant-wide `NotificationRule` default applies instead (System
   * Configuration gap-fix — previously there was no tenant-wide default at
   * all, so a user with zero preference rows — the normal case, since
   * nothing but the seed script has ever written one — got nothing,
   * silently, regardless of what a tenant admin might want). No rule and no
   * preference for a channel = off (fail-closed), same posture as
   * `FeatureFlagsService.isEnabled`.
   */
  async enqueue(userId: string, eventType: string, payload: Record<string, unknown>): Promise<number> {
    const tenantId = this.tenantContext.requireTenantId();
    const preferences = await this.preferencesRepository.findForUser(userId);
    const preferenceByChannel = new Map(
      preferences.filter((p) => p.eventType === eventType).map((p) => [p.channel, p.enabled]),
    );
    const rules = await this.rulesRepository.findForEventType(eventType);
    const ruleByChannel = new Map(rules.map((r) => [r.channel, r.enabled]));

    const enabledChannels = Object.values(NotificationChannel).filter((channel) => {
      if (preferenceByChannel.has(channel)) {
        return preferenceByChannel.get(channel);
      }
      return ruleByChannel.get(channel) ?? false;
    });

    for (const channel of enabledChannels) {
      await this.deliveryRepository.enqueue(tenantId, userId, channel, eventType, payload);
    }

    if (enabledChannels.length === 0) {
      this.logger.debug(
        `No enabled notification channel (preference or tenant rule) for user=${userId} eventType=${eventType} - nothing enqueued.`,
      );
    }
    return enabledChannels.length;
  }
}
