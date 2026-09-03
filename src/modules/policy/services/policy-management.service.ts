import { Injectable } from '@nestjs/common';
import { IsNull } from 'typeorm';
import { PoliciesRepository } from '../repositories/policies.repository';
import { AbacService } from './abac.service';
import { Policy } from '../entities/policy.entity';
import { PolicyType } from '../entities/policy-type.enum';
import { CreatePolicyDto } from '../dto/create-policy.dto';
import { PolicyNotFoundError } from '../errors/policy-not-found.error';

/**
 * §3.2's `POST /v1/policies` + `GET /v1/policies/{policyId}/history`, and
 * the ABAC gate §3.1 requires for anything scoped below the tenant: writing
 * an org-unit-scoped policy (`Policy.orgUnitId` non-null) requires the
 * caller hold `policy:write` *for that specific org unit* (`AbacService`),
 * not merely `policy:write` somewhere in the tenant (`PermissionsGuard`'s
 * RBAC-only check, already enforced at the controller before this service
 * is even called).
 */
@Injectable()
export class PolicyManagementService {
  constructor(
    private readonly policiesRepository: PoliciesRepository,
    private readonly abac: AbacService,
  ) {}

  async createOrVersion(actorUserId: string, input: CreatePolicyDto): Promise<Policy> {
    const orgUnitId = input.orgUnitId ?? null;
    await this.abac.assertPermittedForOrgUnit(actorUserId, 'policy', 'write', orgUnitId);

    const lineageInput = {
      policyType: input.policyType,
      orgUnitId,
      definition: input.definition,
      effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : new Date(),
    };

    return input.policyGroupId
      ? this.policiesRepository.supersede(input.policyGroupId, lineageInput)
      : this.policiesRepository.createLineage(lineageInput);
  }

  /**
   * Module 11 Gap 1: closes a policy lineage's open version with no
   * successor - same ABAC gate as `createOrVersion` (an org-unit-scoped
   * lineage requires `policy:write` for that specific org unit, not merely
   * anywhere in the tenant).
   */
  async deactivate(actorUserId: string, policyGroupId: string): Promise<Policy> {
    const current = await this.policiesRepository.findOpenVersion(policyGroupId);
    if (!current) {
      throw new PolicyNotFoundError(policyGroupId);
    }
    await this.abac.assertPermittedForOrgUnit(actorUserId, 'policy', 'write', current.orgUnitId);
    return this.policiesRepository.deactivate(policyGroupId);
  }

  async history(policyGroupId: string): Promise<Policy[]> {
    const versions = await this.policiesRepository.history(policyGroupId);
    if (versions.length === 0) {
      throw new PolicyNotFoundError(policyGroupId);
    }
    return versions;
  }

  async getOrFail(id: string): Promise<Policy> {
    const policy = await this.policiesRepository.findOne({ where: { id } as never });
    if (!policy) {
      throw new PolicyNotFoundError(id);
    }
    return policy;
  }

  /** Currently-open (`effective_to IS NULL`) versions only - the "active policy list," not full history. */
  async listActive(policyType?: PolicyType): Promise<Policy[]> {
    return this.policiesRepository.find({
      where: { effectiveTo: IsNull(), ...(policyType ? { policyType } : {}) } as never,
    });
  }
}
