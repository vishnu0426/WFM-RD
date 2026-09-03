import { UseGuards } from '@nestjs/common';
import { Query, Resolver } from '@nestjs/graphql';
import { MarketplaceHealthQueryService } from '../../marketplace/marketplace-health-query.service';
import { MarketplaceHealthSnapshotResult } from '../../marketplace/types';
import { AccessTokenGuard } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../../auth/tenant-token-match.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';

/**
 * Shift Marketplace Manager View phase, §5 of the frontend prompt: the
 * health dashboard's only real query - gated on `marketplace_post:read` as
 * the closest applicable "can see marketplace operational state" audience,
 * same judgment call the frontend nav gate for this page makes.
 */
@Resolver(() => MarketplaceHealthSnapshotResult)
export class MarketplaceHealthResolver {
  constructor(private readonly healthQuery: MarketplaceHealthQueryService) {}

  @Query(() => MarketplaceHealthSnapshotResult, { name: 'marketplaceHealthSnapshot' })
  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('marketplace_post:read')
  async marketplaceHealthSnapshot(): Promise<MarketplaceHealthSnapshotResult> {
    return this.healthQuery.snapshot();
  }
}
