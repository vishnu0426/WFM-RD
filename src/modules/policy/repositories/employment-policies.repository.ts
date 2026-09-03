import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantScopedRepository } from '../../../common/tenant/tenant-scoped.repository';
import { withTenantTransaction } from '../../../common/tenant/with-tenant-transaction';
import { Policy } from '../entities/policy.entity';
import { PolicyType } from '../entities/policy-type.enum';

const EMPLOYMENT_POLICY_TYPES = [
  PolicyType.OVERTIME_THRESHOLD,
  PolicyType.REST_PERIOD_MINIMUM,
  PolicyType.MAX_CONSECUTIVE_DAYS,
  PolicyType.UNION_RULE,
];

/**
 * ADR-0012: `EmploymentPolicy` (Module 02 §2.1) is not a separate table -
 * this is a typed, org-unit-aware view over Module 01's `Policy`/`policies`,
 * restricted to the four employment-scoped `PolicyType` values. Extends
 * `TenantScopedRepository<Policy>` rather than duplicating it so writes go
 * through the exact same guard `PoliciesRepository` uses.
 */
@Injectable()
export class EmploymentPoliciesRepository extends TenantScopedRepository<Policy> {
  constructor(dataSource: DataSource, tenantContext: TenantContextService) {
    super(dataSource, Policy, tenantContext);
  }

  /** Employment policies scoped to a specific org unit, or the tenant-wide set when `orgUnitId` is null. */
  async findForOrgUnit(orgUnitId: string | null): Promise<Policy[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const isPlatformAdmin = this.tenantContext.isPlatformAdmin();
    return withTenantTransaction(this.dataSource, { tenantId, isPlatformAdmin }, (manager) =>
      manager
        .getRepository(Policy)
        .createQueryBuilder('policy')
        .where('policy.tenant_id = :tenantId', { tenantId })
        .andWhere('policy.policy_type IN (:...types)', { types: EMPLOYMENT_POLICY_TYPES })
        .andWhere(orgUnitId ? 'policy.org_unit_id = :orgUnitId' : 'policy.org_unit_id IS NULL', { orgUnitId })
        .getMany(),
    );
  }

  /**
   * The currently-open version (`effective_to IS NULL`) of a lineage - what
   * `EmploymentPoliciesService.create` closes out (setting `effective_to`)
   * when adding a new version, per `uq_policies_one_open_version` (Phase 1).
   */
  async findOpenVersion(policyGroupId: string): Promise<Policy | null> {
    return this.findOne({ where: { policyGroupId, effectiveTo: null } as never });
  }

  /** `PolicyService.GetActivePolicy`'s data-layer query (ADR-0006), scoped to the employment policy types. */
  async findActiveAsOf(policyGroupId: string, asOf: Date): Promise<Policy | null> {
    const tenantId = this.tenantContext.requireTenantId();
    const isPlatformAdmin = this.tenantContext.isPlatformAdmin();
    return withTenantTransaction(this.dataSource, { tenantId, isPlatformAdmin }, (manager) =>
      manager
        .getRepository(Policy)
        .createQueryBuilder('policy')
        .where('policy.tenant_id = :tenantId', { tenantId })
        .andWhere('policy.policy_group_id = :policyGroupId', { policyGroupId })
        .andWhere('policy.policy_type IN (:...types)', { types: EMPLOYMENT_POLICY_TYPES })
        .andWhere('policy.effective_from <= :asOf', { asOf })
        .andWhere('(policy.effective_to IS NULL OR policy.effective_to > :asOf)', { asOf })
        .getOne(),
    );
  }
}
