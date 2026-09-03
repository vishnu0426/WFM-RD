import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { EmployeeGraphQLType } from '../../employee/graphql/employee.type';
import { EmployeeInteractionGraphQLType } from './employee-interaction.type';
import { EmployeeInteractionsService } from '../services/employee-interactions.service';
import { CreateEmployeeInteractionInput } from '../dto/create-employee-interaction.input';
import { AccessTokenGuard } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';

/**
 * Reuses `employee:read`/`employee:write`, same precedent as the sibling
 * employee sub-resource resolvers - disclosed trade-off: coaching/
 * disciplinary notes are more sensitive than most employee-domain data, but
 * this platform has no narrower "HR-confidential" permission tier yet.
 * Anyone who can already read/write employee records can read/write this
 * log; a dedicated permission is a reasonable follow-up if that turns out
 * to be too broad in practice.
 */
@Resolver(() => EmployeeInteractionGraphQLType)
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class EmployeeInteractionResolver {
  constructor(private readonly interactionsService: EmployeeInteractionsService) {}

  @Mutation(() => EmployeeInteractionGraphQLType)
  @RequirePermissions('employee:write')
  async createEmployeeInteraction(
    @Args('input') input: CreateEmployeeInteractionInput,
  ): Promise<EmployeeInteractionGraphQLType> {
    return this.interactionsService.create(input);
  }

  /** Only `body` is patchable - `employeeId`/`interactionType`/`createdBy`/`createdAt` stay immutable, see `EmployeeInteractionsService.update`. */
  @Mutation(() => EmployeeInteractionGraphQLType)
  @RequirePermissions('employee:write')
  async updateEmployeeInteraction(
    @Args('id', { type: () => ID }) id: string,
    @Args('body') body: string,
  ): Promise<EmployeeInteractionGraphQLType> {
    return this.interactionsService.update(id, body);
  }

  /** Hard delete - same permission as create/update, see this resolver's own class doc comment for why. */
  @Mutation(() => Boolean)
  @RequirePermissions('employee:write')
  async deleteEmployeeInteraction(@Args('id', { type: () => ID }) id: string): Promise<boolean> {
    await this.interactionsService.delete(id);
    return true;
  }
}

/** Contributes `Employee.interactions`, same stitching pattern as the sibling field resolvers. */
@Resolver(() => EmployeeGraphQLType)
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class EmployeeInteractionsFieldResolver {
  constructor(private readonly interactionsService: EmployeeInteractionsService) {}

  @ResolveField(() => [EmployeeInteractionGraphQLType], { name: 'interactions' })
  async resolveInteractions(@Parent() employee: EmployeeGraphQLType): Promise<EmployeeInteractionGraphQLType[]> {
    return this.interactionsService.findForEmployee(employee.id);
  }

  @Query(() => [EmployeeInteractionGraphQLType])
  @RequirePermissions('employee:read')
  async employeeInteractions(@Args('employeeId', { type: () => ID }) employeeId: string): Promise<EmployeeInteractionGraphQLType[]> {
    return this.interactionsService.findForEmployee(employeeId);
  }
}
