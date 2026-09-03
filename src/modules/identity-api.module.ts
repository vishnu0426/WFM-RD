import { Module } from '@nestjs/common';
import { IdentityModule } from './identity/identity.module';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './audit/audit.module';
import { SystemLimitsModule } from './policy/system-limits.module';
import { RoleManagementController } from './identity/rest/role-management.controller';
import { UserManagementController } from './identity/rest/user-management.controller';

/**
 * Phase 4's composition root for `/v1/roles`, `/v1/permissions`,
 * `/v1/users/{id}/roles` (§4). `RoleManagementController` needs
 * `IdentityModule`'s `RoleManagementService` *and* `AuthModule`'s
 * `AccessTokenGuard`/`PermissionsGuard`/`UserContextCacheService` - and
 * `AuthModule` already imports `IdentityModule` (for `UsersRepository`,
 * `PasswordAuthService`, ...), so `IdentityModule` importing `AuthModule`
 * back would be circular. Same `OrgApiModule`/`PolicyApiModule` pattern -
 * see either's doc comment.
 *
 * Phase 5 adds `AuditModule` (for `AuditLogRepository`, §4) - no cycle
 * risk, `AuditModule` depends on neither `IdentityModule` nor `AuthModule`.
 *
 * Frontend Phase 8 gap-fix adds `UserManagementController`
 * (`inviteUser`/`accept-invite`/`revokeUserSession`) - same module as
 * `RoleManagementController` for the identical reason (needs both
 * `IdentityModule`'s repositories and `AuthModule`'s `PasswordAuthService`/
 * `RefreshTokenService`, both already imported here).
 */
@Module({
  imports: [IdentityModule, AuthModule, AuditModule, SystemLimitsModule],
  controllers: [RoleManagementController, UserManagementController],
})
export class IdentityApiModule {}
