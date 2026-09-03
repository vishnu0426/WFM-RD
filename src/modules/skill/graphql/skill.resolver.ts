import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { SkillGraphQLType } from './skill.type';
import { EmployeeSkillGraphQLType } from './employee-skill.type';
import { SkillsService } from '../services/skills.service';
import { CreateSkillInput } from '../dto/create-skill.input';
import { UpdateSkillInput } from '../dto/update-skill.input';
import { AccessTokenGuard } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';

/**
 * Gated for the first time here (frontend Phase 1 prerequisite) - no
 * `@UseGuards`/`@RequirePermissions` existed. Reuses `employee` (not a new
 * `skill` resource): skills/certifications are employee-domain data, same
 * reasoning as `OrgUnitResolver`'s own doc comment.
 */
@Resolver(() => SkillGraphQLType)
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class SkillResolver {
  constructor(private readonly skillsService: SkillsService) {}

  @Query(() => SkillGraphQLType)
  @RequirePermissions('employee:read')
  async skill(@Args('id', { type: () => ID }) id: string): Promise<SkillGraphQLType> {
    return this.skillsService.findById(id);
  }

  @Query(() => [SkillGraphQLType])
  @RequirePermissions('employee:read')
  async skills(): Promise<SkillGraphQLType[]> {
    return this.skillsService.findAll();
  }

  @Mutation(() => SkillGraphQLType)
  @RequirePermissions('employee:write')
  async createSkill(@Args('input') input: CreateSkillInput): Promise<SkillGraphQLType> {
    return this.skillsService.create(input);
  }

  @Mutation(() => SkillGraphQLType)
  @RequirePermissions('employee:write')
  async updateSkill(@Args('input') input: UpdateSkillInput): Promise<SkillGraphQLType> {
    return this.skillsService.update(input);
  }
}

/** Separate resolver class: contributes `EmployeeSkill.skill`, not a `SkillGraphQLType` field. */
@Resolver(() => EmployeeSkillGraphQLType)
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class EmployeeSkillFieldResolver {
  constructor(private readonly skillsService: SkillsService) {}

  @ResolveField(() => SkillGraphQLType, { name: 'skill' })
  async resolveSkill(@Parent() employeeSkill: EmployeeSkillGraphQLType): Promise<SkillGraphQLType> {
    return this.skillsService.findById(employeeSkill.skillId);
  }
}
