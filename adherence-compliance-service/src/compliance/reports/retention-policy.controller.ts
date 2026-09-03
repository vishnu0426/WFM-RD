import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { RetentionPolicyService } from './retention-policy.service';
import { SetRetentionPolicyDto } from './dto/set-retention-policy.dto';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { AccessTokenGuard } from '../../auth/access-token.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TenantTokenMatchGuard } from '../../auth/tenant-token-match.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';

export interface RetentionPolicyResponse {
  id: string;
  jurisdiction: string;
  retentionYears: number;
  appliesToReportTypes: string[];
  isPlatformDefault: boolean;
  createdAt: Date;
}

function toResponse(policy: {
  id: string;
  tenantId: string | null;
  jurisdiction: string;
  retentionYears: number;
  appliesToReportTypes: string[];
  createdAt: Date;
}): RetentionPolicyResponse {
  return {
    id: policy.id,
    jurisdiction: policy.jurisdiction,
    retentionYears: policy.retentionYears,
    appliesToReportTypes: policy.appliesToReportTypes,
    isPlatformDefault: policy.tenantId === null,
    createdAt: policy.createdAt,
  };
}

/**
 * §5's retention & legal hold page's own real management surface - closes
 * the gap `ComplianceRetentionPage.tsx`'s own doc comment named ("no
 * management endpoint exists for it today"). `GET` lists tenant overrides
 * plus the platform default for any jurisdiction not overridden (one row
 * per jurisdiction, tenant-specific wins - same precedence
 * `ComplianceReportService.resolveRetentionExpiry` already reads). `PUT`
 * upserts a tenant-scoped override for one jurisdiction - see
 * `RetentionPolicyService`'s own doc comment for why there is no `DELETE`
 * (the table was never granted it).
 *
 * Gated the same way the legal-hold toggle is (`compliance_report:approve`
 * for the write, not `:write`) - changing how long a jurisdiction's
 * compliance reports are retained is the same class of materially
 * higher-stakes, legal-consequential action as placing a legal hold, not
 * an ordinary write.
 */
@Controller('v1/compliance/retention-policies')
export class RetentionPolicyController {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly retentionPolicyService: RetentionPolicyService,
  ) {}

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('compliance_report:read')
  @Get()
  async listPolicies(): Promise<RetentionPolicyResponse[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const policies = await this.retentionPolicyService.listPolicies(tenantId);
    return policies.map(toResponse);
  }

  @UseGuards(AccessTokenGuard, PermissionsGuard, TenantTokenMatchGuard)
  @RequirePermissions('compliance_report:approve')
  @Put(':jurisdiction')
  async setPolicy(
    @Param('jurisdiction') jurisdiction: string,
    @Body() body: SetRetentionPolicyDto,
  ): Promise<RetentionPolicyResponse> {
    const tenantId = this.tenantContext.requireTenantId();
    const policy = await this.retentionPolicyService.setPolicy(tenantId, {
      jurisdiction,
      retentionYears: body.retentionYears,
      appliesToReportTypes: body.appliesToReportTypes,
    });
    return toResponse(policy);
  }
}
