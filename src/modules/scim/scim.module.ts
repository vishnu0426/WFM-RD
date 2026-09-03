import { Module } from '@nestjs/common';
import { ScimAuthGuard } from './guards/scim-auth.guard';
import { ScimUsersService } from './services/scim-users.service';
import { ScimGroupsService } from './services/scim-groups.service';
import { ScimUsersController } from './rest/scim-users.controller';
import { ScimGroupsController } from './rest/scim-groups.controller';
import { ScimDiscoveryController } from './rest/scim-discovery.controller';
import { ScimCredentialsController } from './rest/scim-credentials.controller';
import { AuthModule } from '../auth/auth.module';
import { IdentityModule } from '../identity/identity.module';
import { AuditModule } from '../audit/audit.module';

/**
 * Module 01 Phase 3 (§8, §5.3): SCIM 2.0 provisioning. See docs/phase-3-design-doc.md.
 *
 * Follow-up to Phase 5 (ADR-0044): imports `AuditModule` so `ScimUsersController`/
 * `ScimGroupsController` can record a fire-and-forget `AuditEventBatcherService`
 * entry per mutation - closing the gap ADR-0041 left open for SCIM
 * provisioning. No cycle risk: `AuditModule` depends on neither `AuthModule`
 * nor `IdentityModule`.
 *
 * `ScimCredentialsController` (admin console follow-up) reuses the same
 * `AuthModule`/`AuditModule` imports - it needs `OAuthClientsRepository`/
 * `PasswordHasherService` from the former and `AuditLogRepository` from the
 * latter, both already in scope here.
 */
@Module({
  imports: [AuthModule, IdentityModule, AuditModule],
  providers: [ScimAuthGuard, ScimUsersService, ScimGroupsService],
  controllers: [ScimUsersController, ScimGroupsController, ScimDiscoveryController, ScimCredentialsController],
})
export class ScimModule {}
