import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantScopedRepository } from '../../../common/tenant/tenant-scoped.repository';
import { withTenantTransaction } from '../../../common/tenant/with-tenant-transaction';
import { Policy } from '../entities/policy.entity';
import { PolicyType } from '../entities/policy-type.enum';
import { PolicyNotFoundError } from '../errors/policy-not-found.error';
import { CoreOutboxEventsRepository } from '../../core-eventing/repositories/outbox-events.repository';
import { SUBJECTS, PolicyChangedPayload } from '../../core-eventing/subjects';

type NewPolicyLineageInput = Pick<Policy, 'policyType' | 'orgUnitId' | 'definition' | 'effectiveFrom'>;

@Injectable()
export class PoliciesRepository extends TenantScopedRepository<Policy> {
  constructor(dataSource: DataSource, tenantContext: TenantContextService) {
    super(dataSource, Policy, tenantContext);
  }

  /** Phase 5 (§4): every write that changes which `Policy` version is active publishes `PolicyChanged` in the same transaction (ADR-0039). */
  private async publishPolicyChanged(manager: EntityManager, tenantId: string, policy: Policy): Promise<void> {
    const payload: PolicyChangedPayload = {
      policyId: policy.id,
      policyGroupId: policy.policyGroupId,
      tenantId,
      policyType: policy.policyType,
      orgUnitId: policy.orgUnitId,
      version: policy.version,
      effectiveFrom: policy.effectiveFrom.toISOString(),
    };
    await CoreOutboxEventsRepository.insertWithinTransaction(
      manager,
      tenantId,
      SUBJECTS.POLICY_CHANGED,
      payload as unknown as Record<string, unknown>,
    );
  }

  /** All versions of one logical policy (ADR-0006), oldest first. */
  async history(policyGroupId: string): Promise<Policy[]> {
    return this.find({ where: { policyGroupId } as never, order: { version: 'ASC' } as never });
  }

  /**
   * PolicyService.GetActivePolicy's data-layer query (full evaluation
   * semantics land in Phase 4): the version whose effective window contains
   * `asOf`.
   */
  async findActiveAsOf(policyGroupId: string, asOf: Date): Promise<Policy | null> {
    const tenantId = this.tenantContext.requireTenantId();
    const isPlatformAdmin = this.tenantContext.isPlatformAdmin();
    return withTenantTransaction(this.dataSource, { tenantId, isPlatformAdmin }, (manager) =>
      manager
        .getRepository(Policy)
        .createQueryBuilder('policy')
        .where('policy.tenant_id = :tenantId', { tenantId })
        .andWhere('policy.policy_group_id = :policyGroupId', { policyGroupId })
        .andWhere('policy.effective_from <= :asOf', { asOf })
        .andWhere('(policy.effective_to IS NULL OR policy.effective_to > :asOf)', { asOf })
        .getOne(),
    );
  }

  /**
   * The tenant-wide (`org_unit_id IS NULL`) active policy of a given type, at
   * `asOf` - for callers (like the nightly decay job, ADR-0017) that know
   * *what kind* of policy they need but not its `policyGroupId` ahead of
   * time. Assumes at most one tenant-wide lineage per type in practice;
   * nothing in the schema enforces that beyond convention.
   */
  async findActiveByType(policyType: PolicyType, asOf: Date): Promise<Policy | null> {
    const tenantId = this.tenantContext.requireTenantId();
    const isPlatformAdmin = this.tenantContext.isPlatformAdmin();
    return withTenantTransaction(this.dataSource, { tenantId, isPlatformAdmin }, (manager) =>
      manager
        .getRepository(Policy)
        .createQueryBuilder('policy')
        .where('policy.tenant_id = :tenantId', { tenantId })
        .andWhere('policy.policy_type = :policyType', { policyType })
        .andWhere('policy.org_unit_id IS NULL')
        .andWhere('policy.effective_from <= :asOf', { asOf })
        .andWhere('(policy.effective_to IS NULL OR policy.effective_to > :asOf)', { asOf })
        .getOne(),
    );
  }

  /**
   * `PolicyService.GetActivePolicy`'s (§3.3) type+scope lookup - the
   * general form of `findActiveByType`, additionally accepting an org-unit
   * scope so an org-unit-scoped lineage (e.g. Module 02's `EmploymentPolicy`,
   * ADR-0012) resolves correctly, not just tenant-wide ones.
   */
  async findActiveByTypeAndScope(policyType: PolicyType, orgUnitId: string | null, asOf: Date): Promise<Policy | null> {
    const tenantId = this.tenantContext.requireTenantId();
    const isPlatformAdmin = this.tenantContext.isPlatformAdmin();
    return withTenantTransaction(this.dataSource, { tenantId, isPlatformAdmin }, (manager) => {
      const qb = manager
        .getRepository(Policy)
        .createQueryBuilder('policy')
        .where('policy.tenant_id = :tenantId', { tenantId })
        .andWhere('policy.policy_type = :policyType', { policyType })
        .andWhere('policy.effective_from <= :asOf', { asOf })
        .andWhere('(policy.effective_to IS NULL OR policy.effective_to > :asOf)', { asOf });
      return (
        orgUnitId
          ? qb.andWhere('policy.org_unit_id = :orgUnitId', { orgUnitId })
          : qb.andWhere('policy.org_unit_id IS NULL')
      ).getOne();
    });
  }

  /** The lineage's currently-open version (`effective_to IS NULL`) - `uq_policies_one_open_version` guarantees at most one. */
  async findOpenVersion(policyGroupId: string): Promise<Policy | null> {
    return this.findOne({ where: { policyGroupId, effectiveTo: null } as never });
  }

  /**
   * §3.2's `POST /v1/policies` with no existing lineage: version 1,
   * `policyGroupId` self-referencing (ADR-0006). Uses its own transaction
   * (rather than the inherited `TenantScopedRepository.save`) so the
   * `PolicyChanged` outbox row commits atomically with the `Policy` insert
   * (§4, ADR-0039).
   */
  async createLineage(input: NewPolicyLineageInput): Promise<Policy> {
    const tenantId = this.tenantContext.requireTenantId();
    return withTenantTransaction(this.dataSource, { tenantId }, async (manager) => {
      const id = uuidv4();
      const saved = await manager.getRepository(Policy).save({
        id,
        tenantId,
        policyGroupId: id,
        policyType: input.policyType,
        orgUnitId: input.orgUnitId,
        definition: input.definition,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: null,
        version: 1,
      });
      await this.publishPolicyChanged(manager, tenantId, saved);
      return saved;
    });
  }

  /**
   * §3.2's `POST /v1/policies` versioning an existing lineage: atomically
   * closes the currently-open version's `effective_to` at the new version's
   * `effective_from` and inserts the next version - `uq_policies_one_open_version`
   * would reject a naive two-step (non-transactional) version of this if a
   * concurrent request raced in between, so both writes happen in one
   * transaction.
   */
  async supersede(policyGroupId: string, input: NewPolicyLineageInput): Promise<Policy> {
    const tenantId = this.tenantContext.requireTenantId();
    return withTenantTransaction(this.dataSource, { tenantId }, async (manager) => {
      const current = await manager
        .getRepository(Policy)
        .findOne({ where: { tenantId, policyGroupId, effectiveTo: IsNull() } });
      if (!current) {
        throw new PolicyNotFoundError(policyGroupId);
      }
      await manager.getRepository(Policy).update({ id: current.id, tenantId }, { effectiveTo: input.effectiveFrom });
      const saved = await manager.getRepository(Policy).save({
        id: uuidv4(),
        tenantId,
        policyGroupId,
        policyType: input.policyType,
        orgUnitId: input.orgUnitId,
        definition: input.definition,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: null,
        version: current.version + 1,
      });
      await this.publishPolicyChanged(manager, tenantId, saved);
      return saved;
    });
  }

  /**
   * Module 11 Gap 1 (docs/adr/0155's disclosed geofencing kill-switch gap,
   * generalized to every `PolicyType` rather than geofencing-specific):
   * closes the lineage's open version at "now" with no successor version
   * inserted - reuses `supersede()`'s lineage-closing mechanics, minus the
   * insert. After this, `findActiveAsOf`/`findActiveByTypeAndScope` correctly
   * return nothing for this lineage from this moment on; the closed version
   * itself is still readable via `history()`.
   */
  async deactivate(policyGroupId: string): Promise<Policy> {
    const tenantId = this.tenantContext.requireTenantId();
    return withTenantTransaction(this.dataSource, { tenantId }, async (manager) => {
      const current = await manager
        .getRepository(Policy)
        .findOne({ where: { tenantId, policyGroupId, effectiveTo: IsNull() } });
      if (!current) {
        throw new PolicyNotFoundError(policyGroupId);
      }
      const effectiveTo = new Date();
      await manager.getRepository(Policy).update({ id: current.id, tenantId }, { effectiveTo });
      const updated: Policy = { ...current, effectiveTo };
      await this.publishPolicyChanged(manager, tenantId, updated);
      return updated;
    });
  }
}
