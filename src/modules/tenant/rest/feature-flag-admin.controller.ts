import { Body, Controller, ForbiddenException, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import { IsBoolean } from 'class-validator';
import { AccessTokenGuard, RequestWithTokenClaims } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantsRepository } from '../repositories/tenants.repository';
import { FeatureFlagsRepository } from '../../bulk-import/repositories/feature-flags.repository';
import { FeatureFlagsService } from '../../bulk-import/services/feature-flags.service';
import { AuditLogRepository } from '../../audit/repositories/audit-log.repository';
import { AuditActorType } from '../../audit/entities/audit-actor-type.enum';

class UpdateFeatureFlagDto {
  @IsBoolean()
  enabled!: boolean;
}

interface FeatureFlagTenantRow {
  tenantId: string;
  tenantName: string;
  enabled: boolean;
}

/**
 * Tenant Monitoring console's cross-tenant Feature Flags view (internal,
 * platform_admin only). `org.feature_flags.flag_key` is a free-text
 * column with no enum/catalog anywhere (see the entity's own doc comment
 * - "meant to be reusable by any future feature"), so this is genuinely
 * capable of managing any key, not fabricating a capability the table
 * doesn't have - only `bulk_import_destructive` happens to be in active
 * use today.
 *
 * `FeatureFlagsRepository.findAllForKey` is correct here specifically
 * because this controller's own hard `platform_admin` check + the RLS
 * bypass clause added in `1700000037000-FeatureFlagsPlatformAdminBypass.ts`
 * make it genuinely cross-tenant, not merely "my own tenant" the way
 * calling it from anywhere else in this codebase would degrade to.
 */
@Controller('v1/feature-flags')
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class FeatureFlagAdminController {
  constructor(
    private readonly featureFlagsRepository: FeatureFlagsRepository,
    private readonly featureFlagsService: FeatureFlagsService,
    private readonly tenants: TenantsRepository,
    private readonly tenantContext: TenantContextService,
    private readonly auditLog: AuditLogRepository,
  ) {}

  @Get(':flagKey')
  @RequirePermissions('tenant:read')
  async listForKey(@Req() req: RequestWithTokenClaims, @Param('flagKey') flagKey: string): Promise<{ tenants: FeatureFlagTenantRow[] }> {
    if (!req.tokenClaims!.roles.includes('platform_admin')) {
      throw new ForbiddenException('Only a platform admin may view feature flags across tenants.');
    }
    const [flags, allTenants] = await Promise.all([this.featureFlagsRepository.findAllForKey(flagKey), this.tenants.findAll()]);
    const enabledByTenantId = new Map(flags.map((f) => [f.tenantId, f.enabled]));
    return {
      tenants: allTenants.map((t) => ({ tenantId: t.id, tenantName: t.name, enabled: enabledByTenantId.get(t.id) ?? false })),
    };
  }

  @Put(':flagKey/tenants/:tenantId')
  @RequirePermissions('tenant:write')
  async setForTenant(
    @Req() req: RequestWithTokenClaims,
    @Param('flagKey') flagKey: string,
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateFeatureFlagDto,
  ): Promise<{ tenantId: string; flagKey: string; enabled: boolean }> {
    const claims = req.tokenClaims!;
    if (!claims.roles.includes('platform_admin')) {
      throw new ForbiddenException('Only a platform admin may change another tenant’s feature flags.');
    }
    return this.tenantContext.run({ tenantId }, async () => {
      const before = await this.featureFlagsService.isEnabled(flagKey);
      const enabled = await this.featureFlagsService.setEnabled(flagKey, dto.enabled);
      await this.auditLog.record({
        tenantId,
        actorId: claims.sub,
        actorType: AuditActorType.USER,
        action: 'feature_flag.changed',
        resourceType: 'feature_flag',
        // `resourceId` is a uuid column; flags are keyed by a free-text
        // `flagKey`, not a uuid, so it goes in the state payload instead.
        resourceId: null,
        beforeState: { flagKey, enabled: before },
        afterState: { flagKey, enabled },
        aiRationale: null,
      });
      return { tenantId, flagKey, enabled };
    });
  }
}
