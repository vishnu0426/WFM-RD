import { UseGuards } from '@nestjs/common';
import { Args, GraphQLISODateTime, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { EmploymentPolicyGraphQLType } from './employment-policy.type';
import { EmploymentPoliciesService } from '../services/employment-policies.service';
import { CreateEmploymentPolicyInput } from '../dto/create-employment-policy.input';
import { Policy } from '../entities/policy.entity';
import { AccessTokenGuard } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';

/**
 * `Policy.policyType` is the full `PolicyType` enum; `EmploymentPolicyGraphQLType.policyType`
 * is deliberately the narrower `EmploymentPolicyType` (see that enum's doc
 * comment). The cast is safe here specifically because every row these
 * methods return has already been filtered to the four employment types by
 * `EmploymentPoliciesRepository` - TypeScript just can't see that across the
 * repository boundary.
 */
function toGraphQLType(policy: Policy): EmploymentPolicyGraphQLType {
  return policy as unknown as EmploymentPolicyGraphQLType;
}

/**
 * Gated for the first time here (frontend Phase 1 prerequisite): no
 * `@UseGuards`/`@RequirePermissions` existed despite `createEmploymentPolicy`
 * triggering a real cross-service compliance-floor check
 * (`EmploymentPoliciesService.create` -> `ComplianceGrpcClientService`) -
 * any authenticated caller could create/read employment policies. Reuses
 * the existing `policy` resource (`PolicyManagementController`'s own
 * `policy:read`/`policy:write`), not a new one.
 */
@Resolver(() => EmploymentPolicyGraphQLType)
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class EmploymentPolicyResolver {
  constructor(private readonly employmentPoliciesService: EmploymentPoliciesService) {}

  /** Tenant-wide policies when `orgUnitId` is omitted, matching `EmploymentPoliciesRepository.findForOrgUnit`'s existing convention. */
  @Query(() => [EmploymentPolicyGraphQLType])
  @RequirePermissions('policy:read')
  async employmentPolicies(
    @Args('orgUnitId', { type: () => ID, nullable: true }) orgUnitId?: string,
  ): Promise<EmploymentPolicyGraphQLType[]> {
    const policies = await this.employmentPoliciesService.findForOrgUnit(orgUnitId ?? null);
    return policies.map(toGraphQLType);
  }

  @Query(() => EmploymentPolicyGraphQLType)
  @RequirePermissions('policy:read')
  async employmentPolicy(
    @Args('policyGroupId', { type: () => ID }) policyGroupId: string,
    @Args('asOf', { type: () => GraphQLISODateTime, nullable: true }) asOf?: Date,
  ): Promise<EmploymentPolicyGraphQLType> {
    return toGraphQLType(await this.employmentPoliciesService.findActive(policyGroupId, asOf ?? new Date()));
  }

  @Mutation(() => EmploymentPolicyGraphQLType)
  @RequirePermissions('policy:write')
  async createEmploymentPolicy(
    @Args('input') input: CreateEmploymentPolicyInput,
  ): Promise<EmploymentPolicyGraphQLType> {
    return toGraphQLType(await this.employmentPoliciesService.create(input));
  }
}
