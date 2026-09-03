import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { DataSourceGroupsService } from '../data-source-groups.service';
import { AccessTokenGuard } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../../auth/tenant-token-match.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';
import { CurrentTokenClaims } from '../../auth/current-token-claims.decorator';
import { AccessTokenClaims } from '../../auth/access-token.guard';
import {
  DataSourceGroupQueueResult,
  DataSourceGroupResult,
  toDataSourceGroupQueueResult,
  toDataSourceGroupResult,
} from './types';

function actorFromClaims(claims: AccessTokenClaims | undefined) {
  return { id: claims?.sub ?? null, type: 'user' as const };
}

/** Tenant Admin Integration Management, WP3. Same guard trio/permission-naming convention as `IntegrationConnectorResolver`. */
@Resolver(() => DataSourceGroupResult)
export class DataSourceGroupResolver {
  constructor(
    private readonly groups: DataSourceGroupsService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('data_source_group:read')
  @Query(() => [DataSourceGroupResult], { name: 'dataSourceGroups' })
  async dataSourceGroups(
    @Args('dataSourceId', { type: () => ID, nullable: true }) dataSourceId?: string,
  ): Promise<DataSourceGroupResult[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const rows = await this.groups.findAllForTenant(tenantId, dataSourceId);
    return rows.map(toDataSourceGroupResult);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('data_source_group:read')
  @Query(() => [DataSourceGroupQueueResult], { name: 'dataSourceGroupQueues' })
  async dataSourceGroupQueues(@Args('groupId', { type: () => ID }) groupId: string): Promise<DataSourceGroupQueueResult[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const rows = await this.groups.queuesForGroup(tenantId, groupId);
    return rows.map(toDataSourceGroupQueueResult);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('data_source_group:write')
  @Mutation(() => DataSourceGroupResult)
  async upsertDataSourceGroup(
    @Args('id', { type: () => ID, nullable: true }) id: string | null,
    @Args('dataSourceId', { type: () => ID }) dataSourceId: string,
    @Args('name') name: string,
    @Args('description', { nullable: true }) description?: string,
    @Args('type', { nullable: true }) type?: string,
    @Args('avgWorkTimeSeconds', { type: () => Number, nullable: true }) avgWorkTimeSeconds?: number,
    @CurrentTokenClaims() claims?: AccessTokenClaims,
  ): Promise<DataSourceGroupResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const row = await this.groups.upsert(
      tenantId,
      id ?? null,
      { dataSourceId, name, description, type, avgWorkTimeSeconds },
      actorFromClaims(claims),
    );
    return toDataSourceGroupResult(row);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('data_source_group:delete')
  @Mutation(() => Boolean)
  async deleteDataSourceGroup(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTokenClaims() claims?: AccessTokenClaims,
  ): Promise<boolean> {
    const tenantId = this.tenantContext.requireTenantId();
    await this.groups.remove(tenantId, id, actorFromClaims(claims));
    return true;
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('data_source_group:write')
  @Mutation(() => DataSourceGroupQueueResult)
  async addDataSourceGroupQueue(
    @Args('groupId', { type: () => ID }) groupId: string,
    @Args('ccQueueId', { type: () => ID }) ccQueueId: string,
  ): Promise<DataSourceGroupQueueResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const row = await this.groups.addQueue(tenantId, groupId, ccQueueId);
    return toDataSourceGroupQueueResult(row);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('data_source_group:write')
  @Mutation(() => Boolean)
  async removeDataSourceGroupQueue(
    @Args('groupId', { type: () => ID }) groupId: string,
    @Args('ccQueueId', { type: () => ID }) ccQueueId: string,
  ): Promise<boolean> {
    const tenantId = this.tenantContext.requireTenantId();
    await this.groups.removeQueue(tenantId, groupId, ccQueueId);
    return true;
  }
}
