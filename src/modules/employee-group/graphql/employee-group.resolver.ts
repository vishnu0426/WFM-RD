import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { EmployeeGraphQLType } from '../../employee/graphql/employee.type';
import { EmployeeGroupGraphQLType } from './employee-group.type';
import { EmployeeGroupsService } from '../services/employee-groups.service';
import { CreateEmployeeGroupInput } from '../dto/create-employee-group.input';
import { UpdateEmployeeGroupInput } from '../dto/update-employee-group.input';
import { EmployeeGroupFilterInput } from '../dto/employee-group-filter.input';
import { AccessTokenGuard } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';

/** Reuses `employee:read`/`employee:write` (not a new `employee_group` resource) - same precedent as `SkillResolver`'s own doc comment: groups are employee-domain admin data. */
@Resolver(() => EmployeeGroupGraphQLType)
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class EmployeeGroupResolver {
  constructor(private readonly groupsService: EmployeeGroupsService) {}

  @Query(() => [EmployeeGroupGraphQLType])
  @RequirePermissions('employee:read')
  async employeeGroups(
    @Args('filter', { type: () => EmployeeGroupFilterInput, nullable: true }) filter: EmployeeGroupFilterInput = {},
  ): Promise<EmployeeGroupGraphQLType[]> {
    return this.groupsService.findAll(filter);
  }

  @Query(() => EmployeeGroupGraphQLType)
  @RequirePermissions('employee:read')
  async employeeGroup(@Args('id', { type: () => ID }) id: string): Promise<EmployeeGroupGraphQLType> {
    return this.groupsService.findById(id);
  }

  @ResolveField(() => [ID], { name: 'memberEmployeeIds' })
  async resolveMemberEmployeeIds(@Parent() group: EmployeeGroupGraphQLType): Promise<string[]> {
    return (await this.groupsService.listMembers(group.id)).map((m) => m.employeeId);
  }

  @Mutation(() => EmployeeGroupGraphQLType)
  @RequirePermissions('employee:write')
  async createEmployeeGroup(@Args('input') input: CreateEmployeeGroupInput): Promise<EmployeeGroupGraphQLType> {
    return this.groupsService.create(input);
  }

  @Mutation(() => EmployeeGroupGraphQLType)
  @RequirePermissions('employee:write')
  async updateEmployeeGroup(@Args('input') input: UpdateEmployeeGroupInput): Promise<EmployeeGroupGraphQLType> {
    return this.groupsService.update(input);
  }

  @Mutation(() => Boolean)
  @RequirePermissions('employee:write')
  async deleteEmployeeGroup(@Args('id', { type: () => ID }) id: string): Promise<boolean> {
    await this.groupsService.delete(id);
    return true;
  }

  @Mutation(() => EmployeeGroupGraphQLType)
  @RequirePermissions('employee:write')
  async addEmployeeToGroup(
    @Args('groupId', { type: () => ID }) groupId: string,
    @Args('employeeId', { type: () => ID }) employeeId: string,
  ): Promise<EmployeeGroupGraphQLType> {
    await this.groupsService.addMember(groupId, employeeId);
    return this.groupsService.findById(groupId);
  }

  @Mutation(() => EmployeeGroupGraphQLType)
  @RequirePermissions('employee:write')
  async removeEmployeeFromGroup(
    @Args('groupId', { type: () => ID }) groupId: string,
    @Args('employeeId', { type: () => ID }) employeeId: string,
  ): Promise<EmployeeGroupGraphQLType> {
    await this.groupsService.removeMember(groupId, employeeId);
    return this.groupsService.findById(groupId);
  }
}

/** Separate resolver class: contributes `Employee.groups`, same stitching pattern as `EmployeeSkillsFieldResolver`. */
@Resolver(() => EmployeeGraphQLType)
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class EmployeeGroupsFieldResolver {
  constructor(private readonly groupsService: EmployeeGroupsService) {}

  @ResolveField(() => [EmployeeGroupGraphQLType], { name: 'groups' })
  async resolveGroups(@Parent() employee: EmployeeGraphQLType): Promise<EmployeeGroupGraphQLType[]> {
    const groupIds = await this.groupsService.findGroupIdsForEmployee(employee.id);
    return Promise.all(groupIds.map((id) => this.groupsService.findById(id)));
  }
}
