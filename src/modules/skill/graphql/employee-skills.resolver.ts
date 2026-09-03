import { UseGuards } from '@nestjs/common';
import { Args, ID, Int, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { EmployeeGraphQLType } from '../../employee/graphql/employee.type';
import { EmployeeSkillGraphQLType } from './employee-skill.type';
import { EmployeeSkillHistoryEntryType } from './employee-skill-history-entry.type';
import { EmployeeSkillsService } from '../services/employee-skills.service';
import { EmployeeSkillHistoryRepository } from '../repositories/employee-skill-history.repository';
import { UpdateEmployeeSkillsInput } from '../dto/update-employee-skills.input';
import { AccessTokenGuard } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';

/**
 * Contributes `Employee.skills` (closing the gap ADR-0015 explicitly left
 * for Phase 4) plus `updateEmployeeSkills`/`skillsExpiringSoon` (§3.1).
 * Registered from `SkillModule`, not `EmployeeModule` or `OrgApiModule` -
 * NestJS's code-first schema builder stitches `@Resolver(() =>
 * EmployeeGraphQLType)` contributions into the one global `Employee` type
 * regardless of which module the resolver class lives in, so this can sit
 * next to the rest of the skills surface without `SkillModule` and
 * `EmployeeModule` needing to import each other.
 */
@Resolver(() => EmployeeGraphQLType)
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class EmployeeSkillsFieldResolver {
  constructor(
    private readonly employeeSkillsService: EmployeeSkillsService,
    private readonly employeeSkillHistoryRepository: EmployeeSkillHistoryRepository,
  ) {}

  @ResolveField(() => [EmployeeSkillGraphQLType], { name: 'skills' })
  async resolveSkills(@Parent() employee: EmployeeGraphQLType): Promise<EmployeeSkillGraphQLType[]> {
    return this.employeeSkillsService.findForEmployee(employee.id);
  }

  @Mutation(() => [EmployeeSkillGraphQLType])
  @RequirePermissions('employee:write')
  async updateEmployeeSkills(@Args('input') input: UpdateEmployeeSkillsInput): Promise<EmployeeSkillGraphQLType[]> {
    return this.employeeSkillsService.updateForEmployee(input);
  }

  @Query(() => [EmployeeSkillGraphQLType])
  @RequirePermissions('employee:read')
  async skillsExpiringSoon(
    @Args('withinDays', { type: () => Int }) withinDays: number,
    @Args('limit', { type: () => Int, nullable: true }) limit = 50,
    @Args('offset', { type: () => Int, nullable: true }) offset = 0,
  ): Promise<EmployeeSkillGraphQLType[]> {
    return this.employeeSkillsService.findExpiring(withinDays, { limit, offset });
  }

  /**
   * GAP-07 fix (enterprise readiness audit, 2026-08-18): full lineage,
   * oldest first - same shape as `EmployeeResolver.employeeHistory`.
   */
  @Query(() => [EmployeeSkillHistoryEntryType])
  @RequirePermissions('employee:read')
  async employeeSkillHistory(
    @Args('employeeId', { type: () => ID }) employeeId: string,
    @Args('skillId', { type: () => ID }) skillId: string,
  ): Promise<EmployeeSkillHistoryEntryType[]> {
    return this.employeeSkillHistoryRepository.findHistory(employeeId, skillId);
  }
}
