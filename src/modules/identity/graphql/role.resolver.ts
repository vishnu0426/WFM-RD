import { UseGuards } from '@nestjs/common';
import { Args, ID, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { RoleGraphQLType } from './role.type';
import { PermissionGraphQLType } from './permission.type';
import { RoleManagementService } from '../services/role-management.service';
import { AccessTokenGuard } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';

/** Phase 6 GraphQL BFF (ADR-0045) - read-only, delegates to `RoleManagementService` (the same service `RoleManagementController` uses). */
@Resolver(() => RoleGraphQLType)
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class RoleResolver {
  constructor(private readonly service: RoleManagementService) {}

  @Query(() => RoleGraphQLType)
  @RequirePermissions('role:read')
  async role(@Args('id', { type: () => ID }) id: string): Promise<RoleGraphQLType> {
    return this.service.getRoleOrFailIncludingSystem(id);
  }

  @Query(() => [RoleGraphQLType])
  @RequirePermissions('role:read')
  async roles(): Promise<RoleGraphQLType[]> {
    return this.service.listRoles();
  }

  @Query(() => [PermissionGraphQLType])
  @RequirePermissions('role:read')
  async permissions(): Promise<PermissionGraphQLType[]> {
    return this.service.listPermissions();
  }

  @ResolveField(() => [PermissionGraphQLType], { name: 'permissions' })
  async resolvePermissions(@Parent() role: RoleGraphQLType): Promise<PermissionGraphQLType[]> {
    return this.service.listPermissionsForRole(role.id);
  }
}
