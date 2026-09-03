import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { FieldAuthorityPoliciesService } from '../field-authority-policies.service';
import { FieldAuthoritySource, FieldConflictAction } from '../../integrations/entities/field-authority-policy.entity';
import { AccessTokenGuard } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../../auth/tenant-token-match.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';
import { FieldAuthorityPolicyResult, toFieldAuthorityPolicyResult } from './types';

/**
 * §3.1. Real upsert (see `FieldAuthorityPoliciesService`'s own doc comment); rejects `connector_type: acd` (§2.2 rule 5).
 *
 * Real-RBAC-gated, same `integration_connector:read`/`:write` reuse as `FieldMappingResolver`'s own doc comment explains.
 */
@Resolver(() => FieldAuthorityPolicyResult)
export class FieldAuthorityPolicyResolver {
  constructor(
    private readonly policies: FieldAuthorityPoliciesService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('integration_connector:read')
  @Query(() => [FieldAuthorityPolicyResult], { name: 'fieldAuthorityPolicies' })
  async fieldAuthorityPolicies(@Args('connectorId') connectorId: string): Promise<FieldAuthorityPolicyResult[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const rows = await this.policies.findAllForConnector(tenantId, connectorId);
    return rows.map(toFieldAuthorityPolicyResult);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('integration_connector:write')
  @Mutation(() => FieldAuthorityPolicyResult)
  async createFieldAuthorityPolicy(
    @Args('connectorId') connectorId: string,
    @Args('fieldName') fieldName: string,
    @Args('authoritativeSource', { type: () => FieldAuthoritySource }) authoritativeSource: FieldAuthoritySource,
    @Args('conflictAction', { type: () => FieldConflictAction }) conflictAction: FieldConflictAction,
  ): Promise<FieldAuthorityPolicyResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const policy = await this.policies.upsert(tenantId, {
      connectorId,
      fieldName,
      authoritativeSource,
      conflictAction,
    });
    return toFieldAuthorityPolicyResult(policy);
  }
}
