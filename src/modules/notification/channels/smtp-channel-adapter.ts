import { Injectable, Logger } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import { NotificationChannel } from '../entities/notification-channel.enum';
import { NotificationChannelAdapter, NotificationDeliveryRequest } from './notification-channel-adapter';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantSettingsRepository } from '../../tenant-settings/repositories/tenant-settings.repository';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { PlatformSettingsRepository } from '../../platform-settings/repositories/platform-settings.repository';

/**
 * System Configuration gap-fix: the real email channel, replacing
 * `LoggingChannelAdapter` for `NotificationChannel.EMAIL` only (sms/push/
 * in_app still have no real provider, so they keep the logging placeholder —
 * see `NotificationModule`'s own doc comment on why that's an honest
 * disclosure, not a gap this class needs to also cover).
 *
 * `NotificationDeliveryDispatcherService`'s drain loop runs with no ambient
 * tenant context (it drains across every tenant), so this adapter — unlike
 * almost everything else in this codebase — must explicitly bind
 * `tenantContext.run({ tenantId: request.tenantId }, ...)` itself rather
 * than relying on a caller having already done so.
 *
 * Platform Settings gap-fix: a tenant missing any of host/port/from-address
 * now falls back field-by-field to the platform-wide SMTP default
 * (Platform Settings → Email) before giving up — only throws if the
 * *effective* (tenant-then-platform) config is still incomplete, so
 * `send` still throws (not a silent success) when neither has one, and the
 * dispatcher's real retry/attempts/failed-after-5 bookkeeping still applies
 * exactly as it would for a real transient SMTP failure.
 */
@Injectable()
export class SmtpChannelAdapter implements NotificationChannelAdapter {
  readonly channel = NotificationChannel.EMAIL;
  private readonly logger = new Logger(SmtpChannelAdapter.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly tenantSettingsRepository: TenantSettingsRepository,
    private readonly usersRepository: UsersRepository,
    private readonly platformSettingsRepository: PlatformSettingsRepository,
  ) {}

  async send(request: NotificationDeliveryRequest): Promise<void> {
    await this.tenantContext.run({ tenantId: request.tenantId }, async () => {
      const tenantSettings = await this.tenantSettingsRepository.getOrCreate();
      let usingPlatformDefault = false;
      let effective = {
        smtpHost: tenantSettings.smtpHost,
        smtpPort: tenantSettings.smtpPort,
        smtpUsername: tenantSettings.smtpUsername,
        smtpPassword: tenantSettings.smtpPassword,
        smtpFromAddress: tenantSettings.smtpFromAddress,
        smtpUseTls: tenantSettings.smtpUseTls,
      };

      if (!effective.smtpHost || !effective.smtpPort || !effective.smtpFromAddress) {
        const platformSettings = await this.platformSettingsRepository.getOrCreate();
        if (platformSettings.smtpHost && platformSettings.smtpPort) {
          usingPlatformDefault = true;
          effective = {
            smtpHost: effective.smtpHost ?? platformSettings.smtpHost,
            smtpPort: effective.smtpPort ?? platformSettings.smtpPort,
            smtpUsername: effective.smtpHost ? effective.smtpUsername : platformSettings.smtpUsername,
            smtpPassword: effective.smtpHost ? effective.smtpPassword : platformSettings.smtpPassword,
            smtpFromAddress: effective.smtpFromAddress ?? platformSettings.smtpFromAddress,
            smtpUseTls: effective.smtpHost ? effective.smtpUseTls : platformSettings.smtpUseTls,
          };
        }
      }

      if (!effective.smtpHost || !effective.smtpPort || !effective.smtpFromAddress) {
        throw new Error(
          'No SMTP configuration set for this tenant, and no platform-wide default SMTP is configured either (Platform Settings → Email).',
        );
      }

      const recipient = await this.usersRepository.findOne({ where: { id: request.userId } as never });
      if (!recipient || !recipient.email) {
        throw new Error(`Recipient user ${request.userId} not found or has no email.`);
      }

      const transport = createTransport({
        host: effective.smtpHost,
        port: effective.smtpPort,
        secure: effective.smtpUseTls,
        auth: effective.smtpUsername ? { user: effective.smtpUsername, pass: effective.smtpPassword ?? undefined } : undefined,
      });

      await transport.sendMail({
        from: effective.smtpFromAddress,
        to: recipient.email,
        subject: `WFM notification: ${request.eventType}`,
        text: JSON.stringify(request.payload, null, 2),
      });
      this.logger.log(
        `Sent ${request.eventType} email to ${recipient.email} (tenant=${request.tenantId}${usingPlatformDefault ? ', using platform-wide default SMTP' : ''}).`,
      );
    });
  }
}
