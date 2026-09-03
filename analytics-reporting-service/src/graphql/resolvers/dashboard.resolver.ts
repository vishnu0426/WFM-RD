import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { DashboardService } from '../../analytics/dashboard.service';
import { DashboardResult, CreateDashboardInputType, toDashboardResult } from '../../analytics/types';
import { AccessTokenGuard, AccessTokenClaims } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../../auth/tenant-token-match.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';
import { CurrentTokenClaims } from '../../auth/current-token-claims.decorator';

/**
 * §4.1's `dashboard`/`myDashboards`/`createDashboard`/`updateDashboard`.
 * Tenant scope still comes via `TenantContextService` (the header-trust
 * `X-Tenant-Id`, cross-checked against the verified JWT's own `tenant_id`
 * claim by `TenantTokenMatchGuard`) - only actor identity moved off that
 * header: ADR-0163 gates every method here with the platform's standard
 * `AccessTokenGuard`/`PermissionsGuard`/`TenantTokenMatchGuard` trio
 * (`dashboard:read`/`dashboard:write`), and actor id/roles now come from
 * `@CurrentTokenClaims()` (`claims.sub`/`claims.roles`) - a verified
 * identity, not the previously-trusted `X-Actor-Id` header - since
 * `sharedWith` resolution needs a roles claim no header carries at all.
 */
@Resolver(() => DashboardResult)
export class DashboardResolver {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly dashboardService: DashboardService,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('dashboard:read')
  @Query(() => DashboardResult, { name: 'dashboard' })
  async dashboard(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTokenClaims() claims: AccessTokenClaims,
  ): Promise<DashboardResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const { dashboard, widgets } = await this.dashboardService.getDashboard(
      tenantId,
      claims.sub as string,
      claims.roles,
      id,
    );
    return toDashboardResult(dashboard, widgets);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('dashboard:read')
  @Query(() => [DashboardResult], { name: 'myDashboards' })
  async myDashboards(@CurrentTokenClaims() claims: AccessTokenClaims): Promise<DashboardResult[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const dashboards = await this.dashboardService.listMyDashboards(tenantId, claims.sub as string, claims.roles);
    return dashboards.map(({ dashboard, widgets }) => toDashboardResult(dashboard, widgets));
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('dashboard:write')
  @Mutation(() => DashboardResult, { name: 'createDashboard' })
  async createDashboard(
    @Args('input') input: CreateDashboardInputType,
    @CurrentTokenClaims() claims: AccessTokenClaims,
  ): Promise<DashboardResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const { dashboard, widgets } = await this.dashboardService.createDashboard(tenantId, claims.sub as string, input);
    return toDashboardResult(dashboard, widgets);
  }

  /** The builder's edit path - see `DashboardService.updateDashboard`'s own doc comment for why this wasn't in §4.1 but is structurally required. Reuses `CreateDashboardInputType` (identical shape) rather than a near-duplicate `UpdateDashboardInputType`. */
  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('dashboard:write')
  @Mutation(() => DashboardResult, { name: 'updateDashboard' })
  async updateDashboard(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: CreateDashboardInputType,
    @CurrentTokenClaims() claims: AccessTokenClaims,
  ): Promise<DashboardResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const { dashboard, widgets } = await this.dashboardService.updateDashboard(
      tenantId,
      claims.sub as string,
      id,
      input,
    );
    return toDashboardResult(dashboard, widgets);
  }
}
