import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { EmployeeGraphQLType } from '../../employee/graphql/employee.type';
import { EmployeeSchedulePreferenceGraphQLType } from './employee-schedule-preference.type';
import { EmployeeSchedulePreferencesService } from '../services/employee-schedule-preferences.service';
import { UpsertEmployeeSchedulePreferenceInput } from '../dto/upsert-employee-schedule-preference.input';
import { AccessTokenGuard } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';

/** Reuses `employee:read`/`employee:write` - same precedent as the other three new employee sub-resource resolvers. */
@Resolver(() => EmployeeSchedulePreferenceGraphQLType)
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class EmployeeSchedulePreferenceResolver {
  constructor(private readonly preferencesService: EmployeeSchedulePreferencesService) {}

  @Query(() => EmployeeSchedulePreferenceGraphQLType, { nullable: true })
  @RequirePermissions('employee:read')
  async employeeSchedulePreference(
    @Args('employeeId', { type: () => ID }) employeeId: string,
  ): Promise<EmployeeSchedulePreferenceGraphQLType | null> {
    return this.preferencesService.findForEmployee(employeeId);
  }

  @Mutation(() => EmployeeSchedulePreferenceGraphQLType)
  @RequirePermissions('employee:write')
  async upsertEmployeeSchedulePreference(
    @Args('input') input: UpsertEmployeeSchedulePreferenceInput,
  ): Promise<EmployeeSchedulePreferenceGraphQLType> {
    return this.preferencesService.upsertForEmployee(input);
  }
}

/** Contributes `Employee.schedulePreference`, same stitching pattern as the sibling field resolvers. */
@Resolver(() => EmployeeGraphQLType)
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class EmployeeSchedulePreferenceFieldResolver {
  constructor(private readonly preferencesService: EmployeeSchedulePreferencesService) {}

  @ResolveField(() => EmployeeSchedulePreferenceGraphQLType, { name: 'schedulePreference', nullable: true })
  async resolveSchedulePreference(
    @Parent() employee: EmployeeGraphQLType,
  ): Promise<EmployeeSchedulePreferenceGraphQLType | null> {
    return this.preferencesService.findForEmployee(employee.id);
  }
}
