import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TenantSettings } from './entities/tenant-settings.entity';
import { TenantSettingsRepository } from './repositories/tenant-settings.repository';
import { TenantSettingsService } from './tenant-settings.service';
import { PlatformSettingsModule } from '../platform-settings/platform-settings.module';

/**
 * Platform Settings gap-fix: `PlatformSettingsModule` added so
 * `TenantSettingsService.updateSecurityPolicy` can enforce the
 * platform-wide security baseline via `PlatformSecurityBaselineService`.
 * Safe: `PlatformSettingsModule` is a true leaf (only `TypeOrmModule.
 * forFeature`), so it can't loop back to `AuthModule` (which imports this
 * module) or anything that imports `AuthModule`/this module.
 */
@Module({
  imports: [TypeOrmModule.forFeature([TenantSettings]), PlatformSettingsModule],
  providers: [TenantSettingsRepository, TenantSettingsService],
  exports: [TypeOrmModule, TenantSettingsRepository, TenantSettingsService],
})
export class TenantSettingsModule {}
