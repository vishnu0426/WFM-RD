import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationPreference } from './entities/notification-preference.entity';
import { NotificationDelivery } from './entities/notification-delivery.entity';
import { NotificationRule } from './entities/notification-rule.entity';
import { NotificationChannel } from './entities/notification-channel.enum';
import { NotificationPreferencesRepository } from './repositories/notification-preferences.repository';
import { NotificationDeliveryRepository } from './repositories/notification-delivery.repository';
import { NotificationRulesRepository } from './repositories/notification-rules.repository';
import { NotificationService } from './services/notification.service';
import { NotificationDeliveryDispatcherService } from './services/notification-delivery-dispatcher.service';
import { NOTIFICATION_CHANNEL_ADAPTERS } from './channels/notification-channel-adapter';
import { LoggingChannelAdapter } from './channels/logging-channel-adapter';
import { SmtpChannelAdapter } from './channels/smtp-channel-adapter';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { TenantSettingsModule } from '../tenant-settings/tenant-settings.module';
import { TenantSettingsRepository } from '../tenant-settings/repositories/tenant-settings.repository';
import { IdentityModule } from '../identity/identity.module';
import { UsersRepository } from '../identity/repositories/users.repository';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { NotificationRulesController } from './rest/notification-rules.controller';
import { PlatformSettingsModule } from '../platform-settings/platform-settings.module';
import { PlatformSettingsRepository } from '../platform-settings/repositories/platform-settings.repository';

/**
 * GAP-05 fix (enterprise readiness audit, 2026-08-18): this module used to
 * contain nothing but `NotificationPreference` storage - `NotificationService`
 * (enqueue) and `NotificationDeliveryDispatcherService` (drain/send) are the
 * real delivery engine that closes that gap. See `1700000016000-NotificationDeliverySchema`
 * and each service/repository's own doc comment for the full rationale.
 *
 * `NOTIFICATION_CHANNEL_ADAPTERS` is a multi-provider array, one
 * `LoggingChannelAdapter` per `NotificationChannel` today - replacing the
 * placeholder for a given channel with a real provider (e.g. a future
 * `SendgridChannelAdapter` for `email`) is a matter of adding one more
 * provider to this array and removing that channel's `LoggingChannelAdapter`
 * entry, not touching the dispatcher itself.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([NotificationPreference, NotificationDelivery, NotificationRule]),
    TenantSettingsModule,
    IdentityModule,
    AuthModule,
    AuditModule,
    PlatformSettingsModule,
  ],
  providers: [
    NotificationPreferencesRepository,
    NotificationDeliveryRepository,
    NotificationRulesRepository,
    NotificationService,
    NotificationDeliveryDispatcherService,
    {
      provide: NOTIFICATION_CHANNEL_ADAPTERS,
      useFactory: (
        tenantContext: TenantContextService,
        tenantSettingsRepository: TenantSettingsRepository,
        usersRepository: UsersRepository,
        platformSettingsRepository: PlatformSettingsRepository,
      ) =>
        Object.values(NotificationChannel).map((channel) =>
          channel === NotificationChannel.EMAIL
            ? new SmtpChannelAdapter(tenantContext, tenantSettingsRepository, usersRepository, platformSettingsRepository)
            : new LoggingChannelAdapter(channel),
        ),
      inject: [TenantContextService, TenantSettingsRepository, UsersRepository, PlatformSettingsRepository],
    },
  ],
  controllers: [NotificationRulesController],
  exports: [
    TypeOrmModule,
    NotificationPreferencesRepository,
    NotificationDeliveryRepository,
    NotificationRulesRepository,
    NotificationService,
  ],
})
export class NotificationModule {}
