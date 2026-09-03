import { Module } from '@nestjs/common';
import { TenantModule } from './tenant/tenant.module';
import { IdentityModule } from './identity/identity.module';
import { PolicyModule } from './policy/policy.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { EmployeeModule } from './employee/employee.module';
import { OrgUnitModule } from './org-unit/org-unit.module';
import { TenantResolver } from './tenant/graphql/tenant.resolver';
import { UserResolver } from './identity/graphql/user.resolver';
import { RoleResolver } from './identity/graphql/role.resolver';
import { PolicyResolver } from './policy/graphql/policy.resolver';
import { AuditLogResolver } from './audit/graphql/audit-log.resolver';

/**
 * Phase 6's GraphQL BFF (§3.2, ADR-0045) for Module 01's own domain -
 * `Tenant`/`User`/`Role`/`Permission`/`Policy`/`AuditLogEntry`, plus `me`.
 * Deliberately read-only this phase (see ADR-0045's consequences) - REST
 * remains the mutation path for all of these.
 *
 * Composition root, same shape as `TenantApiModule`/`PolicyApiModule`/
 * `IdentityApiModule`/`AuditApiModule` (ADR-0037): these resolvers need
 * services from four different feature modules *and* `AuthModule`'s
 * (now GraphQL-aware, see `AccessTokenGuard`'s doc comment) guards. No cycle
 * risk - `TenantModule`/`IdentityModule`/`PolicyModule`/`AuditModule` import
 * neither `AuthModule` nor each other in this direction.
 *
 * `EmployeeModule` added (ADR-0150's gap): `UserResolver`'s new
 * `me.employee` field needs `EmployeesRepository.findByUserId` - same
 * cross-module-resolver-needs-both-sides shape `OrgApiModule` already uses
 * for `EmployeeResolver`/`OrgUnitResolver`, just one level up.
 *
 * `OrgUnitModule` added (frontend Phase 0 foundation): `UserResolver`'s new
 * `me.orgUnitScope` field needs `OrgUnitsRepository.findById` to resolve
 * scoped org unit names for display. No cycle risk - `OrgUnitModule` imports
 * nothing but `TypeOrmModule` itself.
 */
@Module({
  imports: [TenantModule, IdentityModule, PolicyModule, AuditModule, AuthModule, EmployeeModule, OrgUnitModule],
  providers: [TenantResolver, UserResolver, RoleResolver, PolicyResolver, AuditLogResolver],
})
export class PlatformGraphQLModule {}
