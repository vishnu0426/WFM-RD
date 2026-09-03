import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { FieldMappingsService } from '../field-mappings.service';
import { FieldMappingAuthority } from '../../integrations/entities/field-mapping.entity';
import { AccessTokenGuard } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../../auth/tenant-token-match.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';
import { FieldMappingResult, toFieldMappingResult } from './types';

/**
 * §3.1. Real upsert, not update-only - see `FieldMappingsService`'s own doc comment.
 *
 * Real-RBAC-gated (closing the scope boundary `graphql.module.ts`'s own
 * doc comment disclosed) - a field mapping is a connector sub-resource,
 * so it reuses `integration_connector:write` rather than a new resource,
 * same "reuse the closely-related existing resource" precedent
 * `TenantIdentityProvidersController` set by reusing `tenant` for IdP config.
 */
@Resolver(() => FieldMappingResult)
export class FieldMappingResolver {
  constructor(
    private readonly fieldMappingsService: FieldMappingsService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('integration_connector:read')
  @Query(() => [FieldMappingResult], { name: 'fieldMappings' })
  async fieldMappings(@Args('connectorId') connectorId: string): Promise<FieldMappingResult[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const rows = await this.fieldMappingsService.findAllForConnector(tenantId, connectorId);
    return rows.map(toFieldMappingResult);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('integration_connector:write')
  @Mutation(() => FieldMappingResult)
  async updateFieldMapping(
    @Args('connectorId') connectorId: string,
    @Args('sourceField') sourceField: string,
    @Args('targetField') targetField: string,
    @Args('transformationRule', { type: () => Object, nullable: true }) transformationRule?: Record<string, unknown>,
    @Args('authority', { type: () => FieldMappingAuthority, nullable: true }) authority?: FieldMappingAuthority,
  ): Promise<FieldMappingResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const mapping = await this.fieldMappingsService.upsert(tenantId, {
      connectorId,
      sourceField,
      targetField,
      transformationRule,
      authority,
    });
    return toFieldMappingResult(mapping);
  }
}
