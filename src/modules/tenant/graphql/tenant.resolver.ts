import { UseGuards } from '@nestjs/common';
import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import { TenantGraphQLType } from './tenant.type';
import { TenantsRepository } from '../repositories/tenants.repository';
import { TenantNotFoundError } from '../errors/tenant-not-found.error';
import { AccessTokenGuard } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';

/** Phase 6 GraphQL BFF (ADR-0045) - read-only, mirrors `TenantManagementController`'s REST reads. */
@Resolver(() => TenantGraphQLType)
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class TenantResolver {
  constructor(private readonly tenants: TenantsRepository) {}

  @Query(() => TenantGraphQLType)
  @RequirePermissions('tenant:read')
  async tenant(@Args('id', { type: () => ID }) id: string): Promise<TenantGraphQLType> {
    const tenant = await this.tenants.findById(id);
    if (!tenant) {
      throw new TenantNotFoundError(id);
    }
    return tenant;
  }

  @Query(() => TenantGraphQLType)
  @RequirePermissions('tenant:read')
  async myTenant(): Promise<TenantGraphQLType> {
    const tenant = await this.tenants.findSelf();
    if (!tenant) {
      throw new TenantNotFoundError('self');
    }
    return tenant;
  }

  @Query(() => [TenantGraphQLType])
  @RequirePermissions('tenant:read')
  async tenantChildren(
    @Args('parentTenantId', { type: () => ID, nullable: true }) parentTenantId?: string,
  ): Promise<TenantGraphQLType[]> {
    const self = await this.tenants.findSelf();
    return this.tenants.findChildren(parentTenantId ?? self?.id ?? '');
  }
}
