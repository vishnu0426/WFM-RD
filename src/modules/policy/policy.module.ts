import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Policy } from './entities/policy.entity';
import { PoliciesRepository } from './repositories/policies.repository';
import { EmploymentPoliciesRepository } from './repositories/employment-policies.repository';
import { EmploymentPoliciesService } from './services/employment-policies.service';
import { AbacService } from './services/abac.service';
import { PolicyManagementService } from './services/policy-management.service';
import { OrgUnitModule } from '../org-unit/org-unit.module';
import { CoreEventingModule } from '../core-eventing/core-eventing.module';
import { ComplianceGrpcClientModule } from '../../grpc/compliance-grpc-client.module';

/**
 * Imports `OrgUnitModule` (Module 02) so `EmploymentPoliciesService` can
 * validate a policy's `orgUnitId` - an unusual dependency direction for a
 * nominally Module 01 module, but a direct continuation of ADR-0012's own
 * choice to keep `EmploymentPolicy` inside `core.policies`/this module
 * rather than a parallel Module 02 structure. `OrgUnitModule` has no
 * reverse dependency on `PolicyModule`.
 *
 * Deliberately does NOT import `AuthModule` even though `PolicyManagementController`
 * (Phase 4) needs `AccessTokenGuard`/`PermissionsGuard` from it - `AuthModule`
 * already imports `PolicyModule` (for `AuthMethodPolicyService`), so the
 * reverse import would be circular. `PolicyApiModule` is the composition
 * root that imports both and owns that controller, the same pattern
 * `OrgApiModule` (Module 02) already established for this exact shape of
 * problem - see that module's own doc comment.
 *
 * `EmploymentPolicyResolver` moved to `PolicyApiModule` for the same reason
 * (frontend Phase 1 prerequisite): gating it needs `AuthModule`'s guards,
 * which this module still can't import directly.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Policy]), OrgUnitModule, CoreEventingModule, ComplianceGrpcClientModule],
  providers: [
    PoliciesRepository,
    EmploymentPoliciesRepository,
    EmploymentPoliciesService,
    AbacService,
    PolicyManagementService,
  ],
  exports: [
    TypeOrmModule,
    PoliciesRepository,
    EmploymentPoliciesRepository,
    EmploymentPoliciesService,
    AbacService,
    PolicyManagementService,
  ],
})
export class PolicyModule {}
