import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { IntegrationServersService } from '../integration-servers.service';
import { IntegrationServerRole } from '../../integrations/entities/integration-server.entity';
import { AccessTokenGuard } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../../auth/tenant-token-match.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';
import { CurrentTokenClaims } from '../../auth/current-token-claims.decorator';
import { AccessTokenClaims } from '../../auth/access-token.guard';
import {
  IntegrationConnectorServerResult,
  IntegrationServerResult,
  toIntegrationConnectorServerResult,
  toIntegrationServerResult,
} from './types';

function actorFromClaims(claims: AccessTokenClaims | undefined) {
  return { id: claims?.sub ?? null, type: 'user' as const };
}

/** Same guard trio/permission-naming convention as `DataSourceGroupResolver`. See `IntegrationServer`'s own doc comment: a real registry, not a control plane. */
@Resolver(() => IntegrationServerResult)
export class IntegrationServerResolver {
  constructor(
    private readonly servers: IntegrationServersService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('integration_server:read')
  @Query(() => [IntegrationServerResult], { name: 'integrationServers' })
  async integrationServers(): Promise<IntegrationServerResult[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const rows = await this.servers.findAllForTenant(tenantId);
    return rows.map(toIntegrationServerResult);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('integration_server:read')
  @Query(() => [IntegrationConnectorServerResult], { name: 'integrationServersForConnector' })
  async integrationServersForConnector(@Args('connectorId', { type: () => ID }) connectorId: string): Promise<IntegrationConnectorServerResult[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const rows = await this.servers.serversForConnector(tenantId, connectorId);
    return rows.map(toIntegrationConnectorServerResult);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('integration_server:write')
  @Mutation(() => IntegrationServerResult)
  async upsertIntegrationServer(
    @Args('id', { type: () => ID, nullable: true }) id: string | null,
    @Args('name') name: string,
    @Args('serverName') serverName: string,
    @Args('roles', { type: () => [IntegrationServerRole] }) roles: IntegrationServerRole[],
    @Args('description', { nullable: true }) description?: string,
    @Args('portNumber', { type: () => Number, nullable: true }) portNumber?: number,
    @Args('httpsPortNumber', { type: () => Number, nullable: true }) httpsPortNumber?: number,
    @Args('httpAlias', { nullable: true }) httpAlias?: string,
    @Args('blocked', { type: () => Boolean, nullable: true }) blocked?: boolean,
    @CurrentTokenClaims() claims?: AccessTokenClaims,
  ): Promise<IntegrationServerResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const row = await this.servers.upsert(
      tenantId,
      id ?? null,
      { name, serverName, roles, description, portNumber, httpsPortNumber, httpAlias, blocked },
      actorFromClaims(claims),
    );
    return toIntegrationServerResult(row);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('integration_server:delete')
  @Mutation(() => Boolean)
  async deleteIntegrationServer(@Args('id', { type: () => ID }) id: string, @CurrentTokenClaims() claims?: AccessTokenClaims): Promise<boolean> {
    const tenantId = this.tenantContext.requireTenantId();
    await this.servers.remove(tenantId, id, actorFromClaims(claims));
    return true;
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('integration_server:write')
  @Mutation(() => IntegrationConnectorServerResult)
  async associateIntegrationServer(
    @Args('connectorId', { type: () => ID }) connectorId: string,
    @Args('serverId', { type: () => ID }) serverId: string,
  ): Promise<IntegrationConnectorServerResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const row = await this.servers.associate(tenantId, connectorId, serverId);
    return toIntegrationConnectorServerResult(row);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('integration_server:write')
  @Mutation(() => Boolean)
  async disassociateIntegrationServer(
    @Args('connectorId', { type: () => ID }) connectorId: string,
    @Args('serverId', { type: () => ID }) serverId: string,
  ): Promise<boolean> {
    const tenantId = this.tenantContext.requireTenantId();
    await this.servers.disassociate(tenantId, connectorId, serverId);
    return true;
  }
}
