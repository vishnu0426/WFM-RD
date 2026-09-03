import { Module } from '@nestjs/common';
import { PolicyModule } from './policy/policy.module';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './audit/audit.module';
import { PolicyManagementController } from './policy/rest/policy-management.controller';
import { EmploymentPolicyResolver } from './policy/graphql/employment-policy.resolver';

/**
 * Phase 4's composition root for `/v1/policies` (§3.2), mirroring
 * `OrgApiModule`'s own doc comment: `PolicyManagementController` needs
 * `PolicyModule`'s `PolicyManagementService`/`AbacService` *and*
 * `AuthModule`'s `AccessTokenGuard`/`PermissionsGuard` - and `AuthModule`
 * already imports `PolicyModule` (for `AuthMethodPolicyService`), so
 * `PolicyModule` importing `AuthModule` back would be circular. This module
 * imports both and owns the one controller that needs to see across that
 * boundary; neither `PolicyModule` nor `AuthModule` depends on this module.
 *
 * Phase 5 adds `AuditModule` (for `AuditLogRepository`, §4) - no cycle risk,
 * `AuditModule` depends on neither `PolicyModule` nor `AuthModule`.
 *
 * `EmploymentPolicyResolver` added here too (frontend Phase 1 prerequisite,
 * moved from `PolicyModule`) - same circular-import problem, same fix.
 */
@Module({
  imports: [PolicyModule, AuthModule, AuditModule],
  controllers: [PolicyManagementController],
  providers: [EmploymentPolicyResolver],
})
export class PolicyApiModule {}
