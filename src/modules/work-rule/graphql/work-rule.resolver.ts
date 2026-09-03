import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { EmployeeGraphQLType } from '../../employee/graphql/employee.type';
import { WorkRuleGraphQLType } from './work-rule.type';
import { WorkRuleAssignmentGraphQLType } from './work-rule-assignment.type';
import { WorkRulesService } from '../services/work-rules.service';
import { CreateWorkRuleInput } from '../dto/create-work-rule.input';
import { UpdateWorkRuleInput } from '../dto/update-work-rule.input';
import { AssignWorkRuleInput } from '../dto/assign-work-rule.input';
import { AccessTokenGuard } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';

/** Reuses `employee:read`/`employee:write` - same precedent as `EmployeeGroupResolver`. */
@Resolver(() => WorkRuleGraphQLType)
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class WorkRuleResolver {
  constructor(private readonly workRulesService: WorkRulesService) {}

  @Query(() => [WorkRuleGraphQLType])
  @RequirePermissions('employee:read')
  async workRules(): Promise<WorkRuleGraphQLType[]> {
    return this.workRulesService.findAll();
  }

  @Query(() => WorkRuleGraphQLType)
  @RequirePermissions('employee:read')
  async workRule(@Args('id', { type: () => ID }) id: string): Promise<WorkRuleGraphQLType> {
    return this.workRulesService.findById(id);
  }

  @ResolveField(() => [WorkRuleAssignmentGraphQLType], { name: 'assignments' })
  async resolveAssignments(@Parent() rule: WorkRuleGraphQLType): Promise<WorkRuleAssignmentGraphQLType[]> {
    return this.workRulesService.listAssignments(rule.id);
  }

  @Mutation(() => WorkRuleGraphQLType)
  @RequirePermissions('employee:write')
  async createWorkRule(@Args('input') input: CreateWorkRuleInput): Promise<WorkRuleGraphQLType> {
    return this.workRulesService.create(input);
  }

  @Mutation(() => WorkRuleGraphQLType)
  @RequirePermissions('employee:write')
  async updateWorkRule(@Args('input') input: UpdateWorkRuleInput): Promise<WorkRuleGraphQLType> {
    return this.workRulesService.update(input);
  }

  @Mutation(() => Boolean)
  @RequirePermissions('employee:write')
  async deleteWorkRule(@Args('id', { type: () => ID }) id: string): Promise<boolean> {
    await this.workRulesService.delete(id);
    return true;
  }

  @Mutation(() => WorkRuleGraphQLType)
  @RequirePermissions('employee:write')
  async assignWorkRule(@Args('input') input: AssignWorkRuleInput): Promise<WorkRuleGraphQLType> {
    await this.workRulesService.assign(
      input.workRuleId,
      input.assigneeType,
      input.assigneeId,
      input.priority ?? 0,
      input.effectiveFrom ?? null,
      input.effectiveTo ?? null,
    );
    return this.workRulesService.findById(input.workRuleId);
  }

  @Mutation(() => WorkRuleGraphQLType)
  @RequirePermissions('employee:write')
  async unassignWorkRule(@Args('input') input: AssignWorkRuleInput): Promise<WorkRuleGraphQLType> {
    await this.workRulesService.unassign(input.workRuleId, input.assigneeType, input.assigneeId);
    return this.workRulesService.findById(input.workRuleId);
  }
}

/** Contributes `Employee.workRules` (direct + via-group, resolved), same stitching pattern as `EmployeeGroupsFieldResolver`. */
@Resolver(() => EmployeeGraphQLType)
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class EmployeeWorkRulesFieldResolver {
  constructor(private readonly workRulesService: WorkRulesService) {}

  @ResolveField(() => [WorkRuleGraphQLType], { name: 'workRules' })
  async resolveWorkRules(@Parent() employee: EmployeeGraphQLType): Promise<WorkRuleGraphQLType[]> {
    return this.workRulesService.findForEmployee(employee.id);
  }

  /** GAP-05: the single, tie-broken rule actually in force for this employee today — see `findEffectiveForEmployee`'s own doc comment for the resolution order. */
  @ResolveField(() => WorkRuleGraphQLType, { name: 'effectiveWorkRule', nullable: true })
  async resolveEffectiveWorkRule(@Parent() employee: EmployeeGraphQLType): Promise<WorkRuleGraphQLType | null> {
    return this.workRulesService.findEffectiveForEmployee(employee.id);
  }
}
