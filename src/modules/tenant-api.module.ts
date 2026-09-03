import { Module } from '@nestjs/common';
import { TenantModule } from './tenant/tenant.module';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './audit/audit.module';
import { IdentityModule } from './identity/identity.module';
import { OrgUnitModule } from './org-unit/org-unit.module';
import { TenantSettingsModule } from './tenant-settings/tenant-settings.module';
import { BulkImportModule } from './bulk-import/bulk-import.module';
import { TenantManagementController } from './tenant/rest/tenant-management.controller';
import { FeatureFlagAdminController } from './tenant/rest/feature-flag-admin.controller';

/**
 * Phase 6's composition root for `/v1/tenants` (§3.2), mirroring
 * `PolicyApiModule`/`IdentityApiModule`/`AuditApiModule`:
 * `TenantManagementController` needs `TenantModule`'s `TenantsRepository`
 * *and* `AuthModule`'s guards *and* `AuditModule`'s `AuditLogRepository` -
 * `TenantModule` itself is a leaf (imported nowhere else), so there's no
 * cycle risk in any direction; this module still follows the same
 * composition-root shape for consistency with every other multi-module
 * controller in this repo (ADR-0037).
 *
 * Onboarding gap-fix: also imports `IdentityModule` (for `provisionAdmin`'s
 * `UsersRepository`/`UserRolesRepository`/`RolesRepository`/
 * `InviteTokenService`) - `IdentityModule` is likewise a leaf (only
 * `TypeOrmModule.forFeature` imports of its own), so no cycle risk here
 * either.
 *
 * Tenant Monitoring onboarding-checklist gap-fix: also imports
 * `OrgUnitModule` (for `provisionOrgUnit`'s/`GET .../org-units/exists`'s
 * `OrgUnitsService`) - same leaf-module shape, `OrgUnitModule` doesn't
 * import this module, so no cycle here either.
 *
 * WFM Configuration onboarding-step gap-fix: also imports
 * `TenantSettingsModule` (for `getWfmDefaults`'s/`updateWfmDefaults`'s
 * `TenantSettingsService`) - same leaf-module shape.
 *
 * Cross-tenant Feature Flags gap-fix: also imports `BulkImportModule` (for
 * `FeatureFlagAdminController`'s `FeatureFlagsRepository`/
 * `FeatureFlagsService`) - `BulkImportModule` imports `OrgUnitModule`
 * itself too (already imported here directly), a harmless diamond, not a
 * cycle - it doesn't import `TenantApiModule`.
 */
@Module({
  imports: [TenantModule, AuthModule, AuditModule, IdentityModule, OrgUnitModule, TenantSettingsModule, BulkImportModule],
  controllers: [TenantManagementController, FeatureFlagAdminController],
})
export class TenantApiModule {}
