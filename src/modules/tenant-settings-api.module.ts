import { Module } from '@nestjs/common';
import { TenantSettingsModule } from './tenant-settings/tenant-settings.module';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './audit/audit.module';
import { TenantSettingsController } from './tenant-settings/rest/tenant-settings.controller';

/**
 * Composition root for `/v1/tenant-settings`, mirroring `TenantApiModule`:
 * `TenantSettingsController` needs `TenantSettingsModule`'s service/repo
 * *and* `AuthModule`'s guards *and* `AuditModule`'s `AuditLogRepository`.
 */
@Module({
  imports: [TenantSettingsModule, AuthModule, AuditModule],
  controllers: [TenantSettingsController],
})
export class TenantSettingsApiModule {}
