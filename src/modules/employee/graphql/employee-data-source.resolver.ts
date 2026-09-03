import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { EmployeeGraphQLType } from './employee.type';
import { EmployeeDataSourceGraphQLType } from './employee-data-source.type';
import { EmployeeDataSourcesService } from '../services/employee-data-sources.service';
import { CreateEmployeeDataSourceInput } from '../dto/create-employee-data-source.input';
import { UpdateEmployeeDataSourceInput } from '../dto/update-employee-data-source.input';
import { AccessTokenGuard } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';

/** Reuses `employee:read`/`employee:write`, same precedent as the other employee sub-resource resolvers (schedule preference, interactions, skills). */
@Resolver(() => EmployeeDataSourceGraphQLType)
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class EmployeeDataSourceResolver {
  constructor(private readonly service: EmployeeDataSourcesService) {}

  /**
   * Tenant Admin Integration Management, WP2: the tenant-wide Agent
   * Mapping admin screen needs "every mapping for this tenant" - every
   * prior query here was scoped to a single employee (`Employee.dataSources`
   * field resolver below). `dataSource` optionally narrows to one external
   * connector's mappings, matching the Data Source detail page's own
   * "Mappings" tab.
   */
  @Query(() => [EmployeeDataSourceGraphQLType], { name: 'employeeDataSources' })
  @RequirePermissions('employee:read')
  async employeeDataSources(
    @Args('dataSource', { nullable: true }) dataSource?: string,
  ): Promise<EmployeeDataSourceGraphQLType[]> {
    return this.service.findAllForTenant(dataSource);
  }

  @Mutation(() => EmployeeDataSourceGraphQLType)
  @RequirePermissions('employee:write')
  async addEmployeeDataSource(@Args('input') input: CreateEmployeeDataSourceInput): Promise<EmployeeDataSourceGraphQLType> {
    return this.service.create(input);
  }

  @Mutation(() => EmployeeDataSourceGraphQLType)
  @RequirePermissions('employee:write')
  async updateEmployeeDataSource(@Args('input') input: UpdateEmployeeDataSourceInput): Promise<EmployeeDataSourceGraphQLType> {
    return this.service.update(input);
  }

  @Mutation(() => Boolean)
  @RequirePermissions('employee:write')
  async removeEmployeeDataSource(@Args('id', { type: () => ID }) id: string): Promise<boolean> {
    await this.service.remove(id);
    return true;
  }
}

/** Contributes `Employee.dataSources`, same stitching pattern as the sibling field resolvers (workRules, interactions, schedulePreference). */
@Resolver(() => EmployeeGraphQLType)
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class EmployeeDataSourcesFieldResolver {
  constructor(private readonly service: EmployeeDataSourcesService) {}

  @ResolveField(() => [EmployeeDataSourceGraphQLType], { name: 'dataSources' })
  async resolveDataSources(@Parent() employee: EmployeeGraphQLType): Promise<EmployeeDataSourceGraphQLType[]> {
    return this.service.findForEmployee(employee.id);
  }
}
