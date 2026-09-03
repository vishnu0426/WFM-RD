import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ErasureRequestGraphQLType } from './erasure-request.type';
import { CreateErasureRequestInput } from '../dto/create-erasure-request.input';
import { ErasureRequestsService } from '../services/erasure-requests.service';
import { AccessTokenGuard } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';

/**
 * §2.4/§8. `approveErasureRequest`/`rejectErasureRequest`/`completeErasureRequest`
 * are separate mutations rather than a single `updateErasureRequest(status)` -
 * the same "explicit action, not a generic status setter" reasoning ADR-0016
 * already applied to `updateEmployee` vs `transferEmployee`, and doubly
 * important here since `completeErasureRequest` triggers an irreversible
 * anonymization, not just a status write.
 *
 * Gated for the first time here (frontend Phase 1 prerequisite): no
 * `@UseGuards`/`@RequirePermissions` existed on a mutation that triggers
 * irreversible PII anonymization. `approve`/`reject`/`complete` require
 * `employee:approve` (an elevated action distinct from `employee:write`,
 * matching this phase's spec calling erasure an "elevated permission") -
 * already a seeded permission (every resource gets all four
 * `PermissionAction`s), no new catalog entry needed.
 */
@Resolver(() => ErasureRequestGraphQLType)
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class ErasureRequestResolver {
  constructor(private readonly erasureRequestsService: ErasureRequestsService) {}

  @Query(() => ErasureRequestGraphQLType)
  @RequirePermissions('employee:read')
  async erasureRequest(@Args('id', { type: () => ID }) id: string): Promise<ErasureRequestGraphQLType> {
    return this.erasureRequestsService.findById(id);
  }

  @Query(() => [ErasureRequestGraphQLType])
  @RequirePermissions('employee:read')
  async erasureRequestsForEmployee(
    @Args('employeeId', { type: () => ID }) employeeId: string,
  ): Promise<ErasureRequestGraphQLType[]> {
    return this.erasureRequestsService.findByEmployee(employeeId);
  }

  @Mutation(() => ErasureRequestGraphQLType)
  @RequirePermissions('employee:write')
  async createErasureRequest(
    @Args('employeeId', { type: () => ID }) employeeId: string,
    @Args('input') input: CreateErasureRequestInput,
  ): Promise<ErasureRequestGraphQLType> {
    return this.erasureRequestsService.create(employeeId, input.legalBasis);
  }

  @Mutation(() => ErasureRequestGraphQLType)
  @RequirePermissions('employee:approve')
  async approveErasureRequest(@Args('id', { type: () => ID }) id: string): Promise<ErasureRequestGraphQLType> {
    return this.erasureRequestsService.approve(id);
  }

  @Mutation(() => ErasureRequestGraphQLType)
  @RequirePermissions('employee:approve')
  async rejectErasureRequest(@Args('id', { type: () => ID }) id: string): Promise<ErasureRequestGraphQLType> {
    return this.erasureRequestsService.reject(id);
  }

  @Mutation(() => ErasureRequestGraphQLType)
  @RequirePermissions('employee:approve')
  async completeErasureRequest(@Args('id', { type: () => ID }) id: string): Promise<ErasureRequestGraphQLType> {
    return this.erasureRequestsService.complete(id);
  }
}
