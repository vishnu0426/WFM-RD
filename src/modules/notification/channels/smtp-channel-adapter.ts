import { Injectable, Logger } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import { NotificationChannel } from '../entities/notification-channel.enum';
import { NotificationChannelAdapter, NotificationDeliveryRequest } from './notification-channel-adapter';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantSettingsRepository } from '../../tenant-settings/repositories/tenant-settings.repository';
import { UsersRepository } from '../../identity/repositories/users.repository';

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
 * A tenant with no SMTP host configured genuinely cannot deliver email -
 * `send` throws (not a silent success), so the dispatcher's real
 * retry/attempts/failed-after-5 bookkeeping applies exactly as it would for
 * a real transient SMTP failure.
 */
@Injectable()
export class SmtpChannelAdapter implements NotificationChannelAdapter {
  readonly channel = NotificationChannel.EMAIL;
  private readonly logger = new Logger(SmtpChannelAdapter.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly tenantSettingsRepository: TenantSettingsRepository,
    private readonly usersRepository: UsersRepository,
  ) {}

  async send(request: NotificationDeliveryRequest): Promise<void> {
    await this.tenantContext.run({ tenantId: request.tenantId }, async () => {
      const settings = await this.tenantSettingsRepository.getOrCreate();
      if (!settings.smtpHost || !settings.smtpPort || !settings.smtpFromAddress) {
        throw new Error('No SMTP configuration set for this tenant (System Configuration → Email).');
      }
      const recipient = await this.usersRepository.findOne({ where: { id: request.userId } as never });
      if (!recipient || !recipient.email) {
        throw new Error(`Recipient user ${request.userId} not found or has no email.`);
      }

      const transport = createTransport({
        host: settings.smtpHost,
        port: settings.smtpPort,
        secure: settings.smtpUseTls,
        auth: settings.smtpUsername ? { user: settings.smtpUsername, pass: settings.smtpPassword ?? undefined } : undefined,
      });

      await transport.sendMail({
        from: settings.smtpFromAddress,
        to: recipient.email,
        subject: `WFM notification: ${request.eventType}`,
        text: JSON.stringify(request.payload, null, 2),
      });
      this.logger.log(`Sent ${request.eventType} email to ${recipient.email} (tenant=${request.tenantId}).`);
    });
  }
}
