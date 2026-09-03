import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { EmploymentPoliciesRepository } from '../repositories/employment-policies.repository';
import { EmploymentPolicyNotFoundError } from '../errors/employment-policy-not-found.error';
import { EmploymentPolicyViolatesComplianceFloorError } from '../errors/employment-policy-violates-compliance-floor.error';
import { Policy } from '../entities/policy.entity';
import { PolicyType } from '../entities/policy-type.enum';
import { CreateEmploymentPolicyInput } from '../dto/create-employment-policy.input';
import { OrgUnitsService } from '../../org-unit/services/org-units.service';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { ComplianceGrpcClientService } from '../../../grpc/compliance-grpc-client.service';

@Injectable()
export class EmploymentPoliciesService {
  private readonly logger = new Logger(EmploymentPoliciesService.name);

  constructor(
    private readonly employmentPoliciesRepository: EmploymentPoliciesRepository,
    private readonly orgUnitsService: OrgUnitsService,
    private readonly tenantContext: TenantContextService,
    private readonly complianceGrpcClient: ComplianceGrpcClientService,
  ) {}

  /**
   * The *currently active* policies for this scope - one row per lineage,
   * not full version history (that's `employmentPolicy(policyGroupId, asOf)`
   * for a specific past point, or a future dedicated history query).
   * `EmploymentPoliciesRepository.findForOrgUnit` itself returns every
   * version of every lineage in scope (a reusable, unfiltered primitive);
   * filtering to `effectiveTo === null` here is what makes `employmentPolicies(orgUnitId)`
   * answer "what applies right now," which is what a caller listing
   * policies for an org unit almost always wants.
   */
  async findForOrgUnit(orgUnitId: string | null): Promise<Policy[]> {
    const versions = await this.employmentPoliciesRepository.findForOrgUnit(orgUnitId);
    return versions.filter((v) => v.effectiveTo === null);
  }

  async findActive(policyGroupId: string, asOf: Date): Promise<Policy> {
    const policy = await this.employmentPoliciesRepository.findActiveAsOf(policyGroupId, asOf);
    if (!policy) {
      throw new EmploymentPolicyNotFoundError(policyGroupId);
    }
    return policy;
  }

  /**
   * §3.1's `createEmploymentPolicy`. Two shapes in one mutation (ADR-0018):
   * `policyGroupId` omitted starts a brand-new lineage (`version: 1`);
   * supplied, it adds a new version to an existing lineage, closing the
   * previously-open version's `effectiveTo` first so
   * `uq_policies_one_open_version` (Phase 1) never sees two open rows for
   * the same lineage even transiently within this method.
   *
   * §0.6/ADR-0101: before either branch writes, this policy is checked
   * against Module 08's `ComplianceRuleService.ValidatePolicyAgainstFloor` -
   * the legal floor for its jurisdiction. Fails *closed* on gRPC
   * unavailability (same posture ADR-0074/§2.2-rule-2's own
   * conflict-check precedent uses for a different safety-critical
   * synchronous check) - a policy write this module cannot confirm meets
   * the legal floor must not silently succeed just because the validator
   * was unreachable. Skipped entirely, not failed, when no jurisdiction is
   * resolvable at all (`input.jurisdiction` unset and `orgUnitId` unset or
   * bare of a country code) - there is nothing to validate against.
   */
  async create(input: CreateEmploymentPolicyInput): Promise<Policy> {
    let orgUnitCountryCode: string | null = null;
    if (input.orgUnitId) {
      const orgUnit = await this.orgUnitsService.findById(input.orgUnitId);
      orgUnitCountryCode = orgUnit.countryCode;
    }

    const jurisdiction = input.jurisdiction ?? orgUnitCountryCode;
    if (jurisdiction) {
      await this.validateAgainstComplianceFloor(jurisdiction, input.policyType, input.definition);
    } else {
      this.logger.warn(
        `createEmploymentPolicy for policyType=${input.policyType} has no resolvable jurisdiction (no explicit jurisdiction, no orgUnitId) - compliance floor not checked.`,
      );
    }

    const policyType = input.policyType as unknown as PolicyType;
    const effectiveFrom = new Date(input.effectiveFrom);

    if (input.policyGroupId) {
      const openVersion = await this.employmentPoliciesRepository.findOpenVersion(input.policyGroupId);
      if (!openVersion) {
        throw new EmploymentPolicyNotFoundError(input.policyGroupId);
      }
      await this.employmentPoliciesRepository.update(
        { id: openVersion.id } as never,
        { effectiveTo: effectiveFrom } as never,
      );
      return this.employmentPoliciesRepository.save({
        id: uuidv4(),
        policyGroupId: input.policyGroupId,
        policyType,
        orgUnitId: input.orgUnitId ?? null,
        definition: input.definition,
        effectiveFrom,
        effectiveTo: null,
        version: openVersion.version + 1,
      } as Policy);
    }

    const id = uuidv4();
    return this.employmentPoliciesRepository.save({
      id,
      policyGroupId: id,
      policyType,
      orgUnitId: input.orgUnitId ?? null,
      definition: input.definition,
      effectiveFrom,
      effectiveTo: null,
      version: 1,
    } as Policy);
  }

  private async validateAgainstComplianceFloor(
    jurisdiction: string,
    policyType: string,
    definition: Record<string, unknown>,
  ): Promise<void> {
    const tenantId = this.tenantContext.requireTenantId();
    const result = await this.complianceGrpcClient.validatePolicyAgainstFloor({
      tenantId,
      jurisdiction,
      ruleType: policyType,
      policyDefinitionJson: JSON.stringify(definition),
    });
    if (!result.valid && !result.floorNotFound) {
      throw new EmploymentPolicyViolatesComplianceFloorError(jurisdiction, result.violations);
    }
  }
}
