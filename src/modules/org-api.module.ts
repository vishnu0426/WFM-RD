import { Module } from '@nestjs/common';
import { OrgUnitModule } from './org-unit/org-unit.module';
import { EmployeeModule } from './employee/employee.module';
import { OrgUnitResolver } from './org-unit/graphql/org-unit.resolver';
import { OrgUnitsController } from './org-unit/rest/org-units.controller';
import { EmployeeResolver } from './employee/graphql/employee.resolver';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './audit/audit.module';
import { PolicyModule } from './policy/policy.module';

/**
 * Phase 2's GraphQL/REST composition root for org hierarchy (§3.1, §3.2).
 * `OrgUnitResolver` needs `EmployeeModule`'s repository (`OrgUnit.employees`)
 * and `EmployeeResolver` needs `OrgUnitModule`'s service (`Employee.orgUnit`)
 * - rather than making those two data-layer modules import each other
 * (a circular dependency two Phase 1 modules have no other reason to have),
 * this module imports both and owns the resolvers/controller that actually
 * need to see across the boundary. `OrgUnitModule`/`EmployeeModule`
 * themselves stay exactly as clean as Phase 1 left them.
 *
 * `AuthModule` import added alongside ADR-0150's `EmployeeResolver` guard
 * fix: `@UseGuards(AccessTokenGuard, PermissionsGuard)` needs `TokenService`/
 * `TokenRevocationService`/`PermissionsGuard` resolvable in this module's DI
 * context, which nothing here previously provided - the app failed to boot
 * at all without it (Nest couldn't resolve `AccessTokenGuard`'s
 * constructor), not just failed a request.
 *
 * `AuditModule` import added for GAP-06 (enterprise readiness audit,
 * 2026-08-18): both resolvers now inject `AuditLogRepository` directly -
 * declared here (not `EmployeeModule`/`OrgUnitModule`) for the same reason
 * `AuthModule` is, since both resolvers are themselves declared as this
 * module's own providers, not either data-layer module's.
 *
 * `PolicyModule` import added for the enterprise readiness audit's CRITICAL
 * finding: `EmployeeResolver` had `scope_org_unit_id`/`scope_group_id`
 * stored on role assignments but never consulted, so a "scoped" grant had
 * no actual restricting effect on Employee access. No cycle risk -
 * `PolicyModule` only imports `OrgUnitModule`/`CoreEventingModule`/
 * `ComplianceGrpcClientModule`, none of which import `EmployeeModule`,
 * `AuthModule`, or this module back (see `AbacService.isPermittedForEmployee`'s
 * own doc comment for why the group-membership half is a direct SQL
 * subquery instead of also importing `EmployeeGroupModule`, which *would*
 * have closed a cycle).
 */
@Module({
  imports: [OrgUnitModule, EmployeeModule, AuthModule, AuditModule, PolicyModule],
  providers: [OrgUnitResolver, EmployeeResolver],
  controllers: [OrgUnitsController],
})
export class OrgApiModule {}
