import { UseGuards } from '@nestjs/common';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { FeatureFlagGraphQLType } from './feature-flag.type';
import { FeatureFlagsService } from '../services/feature-flags.service';
import { AccessTokenGuard } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';

/**
 * Not named by §3.1 - added so §0.5's per-tenant feature flag (gating bulk
 * import's destructive mode) is actually toggleable through the API rather
 * than only by direct database access.
 *
 * Gated for the first time here (frontend Phase 1 prerequisite): this had
 * no `@UseGuards` at all - not even `AccessTokenGuard` - meaning anyone
 * could flip a tenant's feature flags, including the one gating bulk
 * import's destructive (non-dry-run) mode, without even authenticating.
 * Reuses `employee` (not a new resource): this flag exists specifically to
 * gate employee bulk-import, the same domain as everything else this
 * session gated with it. ABAC scoping remains the standing gap (ADR-0014)
 * this doc comment already flagged - RBAC only, same as every other
 * resolver fixed this session.
 */
@Resolver()
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class FeatureFlagResolver {
  constructor(private readonly featureFlagsService: FeatureFlagsService) {}

  @Query(() => FeatureFlagGraphQLType)
  @RequirePermissions('employee:read')
  async featureFlag(@Args('flagKey') flagKey: string): Promise<FeatureFlagGraphQLType> {
    const enabled = await this.featureFlagsService.isEnabled(flagKey);
    return { flagKey, enabled };
  }

  @Mutation(() => FeatureFlagGraphQLType)
  @RequirePermissions('employee:write')
  async setFeatureFlag(
    @Args('flagKey') flagKey: string,
    @Args('enabled') enabled: boolean,
  ): Promise<FeatureFlagGraphQLType> {
    const result = await this.featureFlagsService.setEnabled(flagKey, enabled);
    return { flagKey, enabled: result };
  }
}
