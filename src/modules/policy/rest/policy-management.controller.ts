import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AccessTokenGuard, RequestWithTokenClaims } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';
import { PolicyManagementService } from '../services/policy-management.service';
import { CreatePolicyDto } from '../dto/create-policy.dto';
import { Policy } from '../entities/policy.entity';
import { PolicyType } from '../entities/policy-type.enum';
import { AuditLogRepository } from '../../audit/repositories/audit-log.repository';
import { AuditActorType } from '../../audit/entities/audit-actor-type.enum';

/**
 * §3.2's `POST /v1/policies` and `GET /v1/policies/{policyId}/history` -
 * named explicitly in the source spec's REST endpoint table, unlike most of
 * this repo's other `/v1/*` admin surfaces. `{policyId}` in the spec's own
 * path is this table's `policy_group_id` (the lineage key, ADR-0006), not a
 * single version's row `id` - `GET /v1/policies/:id` (a specific version)
 * and `GET /v1/policies/:policyGroupId/history` (the whole lineage) are
 * deliberately different path parameters for that reason.
 *
 * Phase 5 (§4): `create` records an `audit_log` entry after each successful
 * write - one of the representative write paths this phase wires end to
 * end (alongside `RoleManagementController`), not an exhaustive retrofit of
 * every mutation across every phase (see docs/phase-5-design-doc.md's
 * explicit assumptions, the same scope discipline ADR applied to Phase 4's
 * RBAC gating).
 */
@Controller('v1/policies')
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class PolicyManagementController {
  constructor(
    private readonly service: PolicyManagementService,
    private readonly auditLog: AuditLogRepository,
  ) {}

  @Get()
  @RequirePermissions('policy:read')
  async listActive(@Query('policyType') policyType?: PolicyType): Promise<Policy[]> {
    return this.service.listActive(policyType);
  }

  @Get(':id')
  @RequirePermissions('policy:read')
  async get(@Param('id') id: string): Promise<Policy> {
    return this.service.getOrFail(id);
  }

  @Get(':policyGroupId/history')
  @RequirePermissions('policy:read')
  async history(@Param('policyGroupId') policyGroupId: string): Promise<Policy[]> {
    return this.service.history(policyGroupId);
  }

  @Post()
  @RequirePermissions('policy:write')
  async create(@Req() req: RequestWithTokenClaims, @Body() dto: CreatePolicyDto): Promise<Policy> {
    const claims = req.tokenClaims!;
    const policy = await this.service.createOrVersion(claims.sub, dto);
    await this.auditLog.record({
      tenantId: claims.tenant_id,
      actorId: claims.sub,
      actorType: AuditActorType.USER,
      action: dto.policyGroupId ? 'policy.versioned' : 'policy.created',
      resourceType: 'policy',
      resourceId: policy.id,
      beforeState: null,
      afterState: { policyGroupId: policy.policyGroupId, version: policy.version, definition: policy.definition },
      aiRationale: null,
    });
    return policy;
  }

  /**
   * Module 11 Gap 1 (docs/adr/0155's disclosed geofencing kill-switch gap,
   * generalized to every `PolicyType`, not geofencing-specific): closes a
   * lineage's open version with no successor - e.g. an org unit that
   * enabled geofencing can turn it back off without a replacement policy
   * masquerading as "no boundary configured."
   */
  @Post(':policyGroupId/deactivate')
  @RequirePermissions('policy:write')
  async deactivate(@Req() req: RequestWithTokenClaims, @Param('policyGroupId') policyGroupId: string): Promise<Policy> {
    const claims = req.tokenClaims!;
    const policy = await this.service.deactivate(claims.sub, policyGroupId);
    await this.auditLog.record({
      tenantId: claims.tenant_id,
      actorId: claims.sub,
      actorType: AuditActorType.USER,
      action: 'policy.deactivated',
      resourceType: 'policy',
      resourceId: policy.id,
      beforeState: null,
      afterState: { policyGroupId: policy.policyGroupId, version: policy.version, effectiveTo: policy.effectiveTo },
      aiRationale: null,
    });
    return policy;
  }
}
