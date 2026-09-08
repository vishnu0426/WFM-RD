import { Module } from '@nestjs/common';
import { PlatformSettingsModule } from './platform-settings/platform-settings.module';
import { AuthModule } from './auth/auth.module';
import { PlatformSettingsController } from './platform-settings/rest/platform-settings.controller';

/**
 * Composition root for `/v1/platform-settings`, mirroring
 * `TenantSettingsApiModule`: `PlatformSettingsController` needs
 * `PlatformSettingsModule`'s services *and* `AuthModule`'s guards.
 * Imported nowhere else (only from `app.module.ts`), so its own `AuthModule`
 * import carries no cycle risk regardless of what `AuthModule` imports.
 */
@Module({
  imports: [PlatformSettingsModule, AuthModule],
  controllers: [PlatformSettingsController],
})
export class PlatformSettingsApiModule {}
