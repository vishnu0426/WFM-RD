import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlatformSettings } from './entities/platform-settings.entity';
import { PlatformFeatureFlagDefault } from './entities/platform-feature-flag-default.entity';
import { PlatformSettingsRepository } from './repositories/platform-settings.repository';
import { PlatformFeatureFlagDefaultsRepository } from './repositories/platform-feature-flag-defaults.repository';
import { PlatformSettingsService } from './services/platform-settings.service';
import { PlatformSecurityBaselineService } from './services/platform-security-baseline.service';
import { PlatformFeatureFlagDefaultsService } from './services/platform-feature-flag-defaults.service';

/**
 * Leaf module — deliberately imports nothing but `TypeOrmModule.forFeature`
 * (no `AuthModule`, no `NotificationModule`, no `BulkImportModule`, no
 * `TenantApiModule`/`TenantSettingsApiModule`). `TenantSettingsModule`
 * already imports `AuthModule`, so if this module needed `AuthModule` too
 * (e.g. for a controller's guards) and `TenantSettingsModule` imported this
 * module (it does, for `PlatformSecurityBaselineService`), that would be a
 * real cycle: `AuthModule -> TenantSettingsModule -> PlatformSettingsModule
 * -> AuthModule`. The controller that needs `AuthModule`'s guards lives in
 * the separate `PlatformSettingsApiModule` instead — same leaf/
 * composition-root split `tenant-settings.module.ts`/
 * `tenant-settings-api.module.ts` already use for exactly this reason.
 */
@Module({
  imports: [TypeOrmModule.forFeature([PlatformSettings, PlatformFeatureFlagDefault])],
  providers: [
    PlatformSettingsRepository,
    PlatformFeatureFlagDefaultsRepository,
    PlatformSettingsService,
    PlatformSecurityBaselineService,
    PlatformFeatureFlagDefaultsService,
  ],
  exports: [
    TypeOrmModule,
    PlatformSettingsRepository,
    PlatformFeatureFlagDefaultsRepository,
    PlatformSettingsService,
    PlatformSecurityBaselineService,
    PlatformFeatureFlagDefaultsService,
  ],
})
export class PlatformSettingsModule {}
