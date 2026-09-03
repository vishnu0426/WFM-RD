import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { ReasonCodesService } from '../reason-codes.service';
import { AccessTokenGuard } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../../auth/tenant-token-match.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';
import { CurrentTokenClaims } from '../../auth/current-token-claims.decorator';
import { AccessTokenClaims } from '../../auth/access-token.guard';
import { ReasonCodeResult, toReasonCodeResult } from './types';

function actorFromClaims(claims: AccessTokenClaims | undefined) {
  return { id: claims?.sub ?? null, type: 'user' as const };
}

/** Tenant Admin Integration Management, WP3. Same guard trio/permission-naming convention as `IntegrationConnectorResolver`. */
@Resolver(() => ReasonCodeResult)
export class ReasonCodeResolver {
  constructor(
    private readonly reasonCodesService: ReasonCodesService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('reason_code:read')
  @Query(() => [ReasonCodeResult], { name: 'reasonCodes' })
  async reasonCodes(@Args('connectorId', { type: () => ID }) connectorId: string): Promise<ReasonCodeResult[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const rows = await this.reasonCodesService.findAllForConnector(tenantId, connectorId);
    return rows.map(toReasonCodeResult);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('reason_code:write')
  @Mutation(() => ReasonCodeResult)
  async upsertReasonCode(
    @Args('id', { type: () => ID, nullable: true }) id: string | null,
    @Args('connectorId', { type: () => ID }) connectorId: string,
    @Args('externalId') externalId: string,
    @Args('reasonCode') reasonCode: string,
    @Args('shiftOperation') shiftOperation: string,
    @Args('eventMode', { nullable: true }) eventMode?: string,
    @Args('eventReason', { nullable: true }) eventReason?: string,
    @Args('origin', { nullable: true }) origin?: string,
    @CurrentTokenClaims() claims?: AccessTokenClaims,
  ): Promise<ReasonCodeResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const row = await this.reasonCodesService.upsert(
      tenantId,
      id ?? null,
      { connectorId, externalId, reasonCode, shiftOperation, eventMode, eventReason, origin },
      actorFromClaims(claims),
    );
    return toReasonCodeResult(row);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('reason_code:delete')
  @Mutation(() => Boolean)
  async deleteReasonCode(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTokenClaims() claims?: AccessTokenClaims,
  ): Promise<boolean> {
    const tenantId = this.tenantContext.requireTenantId();
    await this.reasonCodesService.remove(tenantId, id, actorFromClaims(claims));
    return true;
  }
}
