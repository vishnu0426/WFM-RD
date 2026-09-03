import { UseGuards } from '@nestjs/common';
import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import { PolicyGraphQLType } from './policy.type';
import { PolicyType } from '../entities/policy-type.enum';
import { PolicyManagementService } from '../services/policy-management.service';
import { AccessTokenGuard } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';

/** Phase 6 GraphQL BFF (ADR-0045) - read-only, delegates to `PolicyManagementService` (the same service `PolicyManagementController` uses). */
@Resolver(() => PolicyGraphQLType)
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class PolicyResolver {
  constructor(private readonly service: PolicyManagementService) {}

  @Query(() => PolicyGraphQLType)
  @RequirePermissions('policy:read')
  async policy(@Args('id', { type: () => ID }) id: string): Promise<PolicyGraphQLType> {
    return this.service.getOrFail(id);
  }

  @Query(() => [PolicyGraphQLType])
  @RequirePermissions('policy:read')
  async policyHistory(@Args('policyGroupId', { type: () => ID }) policyGroupId: string): Promise<PolicyGraphQLType[]> {
    return this.service.history(policyGroupId);
  }

  @Query(() => [PolicyGraphQLType])
  @RequirePermissions('policy:read')
  async policies(
    @Args('policyType', { type: () => PolicyType, nullable: true }) policyType?: PolicyType,
  ): Promise<PolicyGraphQLType[]> {
    return this.service.listActive(policyType);
  }
}
