import { Body, Controller, ForbiddenException, Get, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { AccessTokenGuard, RequestWithTokenClaims } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantSettingsService } from '../../tenant-settings/tenant-settings.service';
import { TenantSettingsView } from '../../tenant-settings/rest/tenant-settings.view';
import { UpdateGeneralSettingsDto } from '../../tenant-settings/dto/update-general-settings.dto';
import { UpdateSecurityPolicyDto } from '../../tenant-settings/dto/update-security-policy.dto';
import { UpdateEmailSettingsDto } from '../../tenant-settings/dto/update-email-settings.dto';
import { PoliciesRepository } from '../../policy/repositories/policies.repository';
import { PolicyType } from '../../policy/entities/policy-type.enum';
import { Policy } from '../../policy/entities/policy.entity';
import { NotificationRulesRepository } from '../../notification/repositories/notification-rules.repository';
import { NotificationRule } from '../../notification/entities/notification-rule.entity';
import { NotificationChannel } from '../../notification/entities/notification-channel.enum';
import { AuditLogRepository } from '../../audit/repositories/audit-log.repository';
import { AuditActorType } from '../../audit/entities/audit-actor-type.enum';

const POLICY_TYPES = [
  PolicyType.AUTH_METHOD_POLICY,
  PolicyType.ACCESS_RESTRICTION_POLICY,
  PolicyType.SYSTEM_LIMITS,
  PolicyType.MAINTENANCE_MODE,
] as const;
type ConfigPolicyType = (typeof POLICY_TYPES)[number];

/**
 * Platform Admin's cross-tenant access to System Configuration
 * (`frontend/src/modules/identity-org/system-config/*.js`'s own-tenant
 * routes have a `:id`-scoped sibling here) — same shape as the existing
 * `TenantManagementController.getWfmDefaults`/`updateWfmDefaults`: hard
 * `platform_admin` check + `tenantContext.run({ tenantId: id }, ...)`
 * wrapping the *same* services the tenant's own routes use, so this is a
 * second entry point onto the same data, not a shadow copy.
 *
 * Policy writes (auth-method/access-restriction/system-limits/maintenance)
 * call `PoliciesRepository.createLineage`/`supersede` directly rather than
 * `PolicyManagementService.createOrVersion` — that service's ABAC gate
 * (`AbacService.assertPermittedForOrgUnit`) is scoped to a real in-tenant
 * actor's own role bindings, which a platform_admin acting cross-tenant
 * doesn't have; the hard role check below is what replaces per-tenant ABAC
 * here, the same substitution every other cross-tenant write in this
 * controller's sibling (`TenantManagementController`) already makes.
 *
 * Scope: General, Security (password policy + auth method + access
 * restrictions), Email, Notifications, Advanced (system limits +
 * maintenance mode). SSO/Identity-Providers CRUD and Retention
 * (cross-service, adherence-compliance-service) are deliberately not here —
 * see this round's plan for why.
 */
@Controller('v1/tenants/:id/config')
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class TenantConfigAdminController {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly settings: TenantSettingsService,
    private readonly policies: PoliciesRepository,
    private readonly notificationRules: NotificationRulesRepository,
    private readonly auditLog: AuditLogRepository,
  ) {}

  private assertPlatformAdmin(req: RequestWithTokenClaims): void {
    if (!req.tokenClaims!.roles.includes('platform_admin')) {
      throw new ForbiddenException('Only a platform admin may configure another tenant.');
    }
  }

  @Get('general')
  @RequirePermissions('tenant_settings:read')
  async getGeneral(@Req() req: RequestWithTokenClaims, @Param('id') id: string): Promise<TenantSettingsView> {
    this.assertPlatformAdmin(req);
    return this.tenantContext.run({ tenantId: id }, () => this.settings.getSettings());
  }

  @Put('general')
  @RequirePermissions('tenant_settings:write')
  async updateGeneral(
    @Req() req: RequestWithTokenClaims,
    @Param('id') id: string,
    @Body() dto: UpdateGeneralSettingsDto,
  ): Promise<TenantSettingsView> {
    this.assertPlatformAdmin(req);
    const claims = req.tokenClaims!;
    return this.tenantContext.run({ tenantId: id }, async () => {
      const before = await this.settings.getSettings();
      const after = await this.settings.updateGeneralSettings(dto);
      await this.auditByPlatformAdmin(claims, id, 'tenant_settings.general_updated', before, after);
      return after;
    });
  }

  @Get('security')
  @RequirePermissions('tenant_settings:read')
  async getSecurity(@Req() req: RequestWithTokenClaims, @Param('id') id: string): Promise<TenantSettingsView> {
    this.assertPlatformAdmin(req);
    return this.tenantContext.run({ tenantId: id }, () => this.settings.getSettings());
  }

  @Put('security')
  @RequirePermissions('tenant_settings:write')
  async updateSecurity(
    @Req() req: RequestWithTokenClaims,
    @Param('id') id: string,
    @Body() dto: UpdateSecurityPolicyDto,
  ): Promise<TenantSettingsView> {
    this.assertPlatformAdmin(req);
    const claims = req.tokenClaims!;
    return this.tenantContext.run({ tenantId: id }, async () => {
      const before = await this.settings.getSettings();
      const after = await this.settings.updateSecurityPolicy(dto);
      await this.auditByPlatformAdmin(claims, id, 'tenant_settings.security_policy_updated', before, after);
      return after;
    });
  }

  @Get('email')
  @RequirePermissions('tenant_settings:read')
  async getEmail(@Req() req: RequestWithTokenClaims, @Param('id') id: string): Promise<TenantSettingsView> {
    this.assertPlatformAdmin(req);
    return this.tenantContext.run({ tenantId: id }, () => this.settings.getSettings());
  }

  @Put('email')
  @RequirePermissions('tenant_settings:write')
  async updateEmail(
    @Req() req: RequestWithTokenClaims,
    @Param('id') id: string,
    @Body() dto: UpdateEmailSettingsDto,
  ): Promise<TenantSettingsView> {
    this.assertPlatformAdmin(req);
    const claims = req.tokenClaims!;
    return this.tenantContext.run({ tenantId: id }, async () => {
      const before = await this.settings.getSettings();
      const after = await this.settings.updateEmailSettings(dto);
      await this.auditByPlatformAdmin(claims, id, 'tenant_settings.email_updated', before, after);
      return after;
    });
  }

  @Post('email/test-connection')
  @RequirePermissions('tenant_settings:read')
  async testEmail(@Req() req: RequestWithTokenClaims, @Param('id') id: string): Promise<{ success: boolean; message: string }> {
    this.assertPlatformAdmin(req);
    return this.tenantContext.run({ tenantId: id }, () => this.settings.testEmailConnection());
  }

  @Get('notification-rules')
  @RequirePermissions('tenant_settings:read')
  async listNotificationRules(@Req() req: RequestWithTokenClaims, @Param('id') id: string): Promise<NotificationRule[]> {
    this.assertPlatformAdmin(req);
    return this.tenantContext.run({ tenantId: id }, () => this.notificationRules.find({}));
  }

  @Put('notification-rules/:eventType/:channel')
  @RequirePermissions('tenant_settings:write')
  async setNotificationRule(
    @Req() req: RequestWithTokenClaims,
    @Param('id') id: string,
    @Param('eventType') eventType: string,
    @Param('channel') channel: string,
    @Body() body: { enabled: boolean },
  ): Promise<NotificationRule> {
    this.assertPlatformAdmin(req);
    if (!Object.values(NotificationChannel).includes(channel as NotificationChannel)) {
      throw new ForbiddenException(`Unknown channel "${channel}".`);
    }
    const claims = req.tokenClaims!;
    return this.tenantContext.run({ tenantId: id }, async () => {
      const after = await this.notificationRules.setEnabled(eventType, channel, body.enabled);
      await this.auditByPlatformAdmin(claims, id, 'notification_rule.changed', null, { eventType, channel, enabled: after.enabled });
      return after;
    });
  }

  // Registered after the literal routes above (general/security/email/
  // notification-rules) and before nothing else — :policyType is a
  // catch-all wildcard, so every literal sub-path must be declared before
  // it or NestJS would match e.g. "notification-rules" as a policyType
  // value instead (same literal-before-param ordering already established
  // in this codebase, see TenantManagementController's "all" vs ":id").
  @Get(':policyType')
  @RequirePermissions('tenant_settings:read')
  async getPolicy(
    @Req() req: RequestWithTokenClaims,
    @Param('id') id: string,
    @Param('policyType') policyType: string,
  ): Promise<Policy | null> {
    this.assertPlatformAdmin(req);
    this.assertKnownPolicyType(policyType);
    return this.tenantContext.run({ tenantId: id }, () => this.policies.findActiveByType(policyType as ConfigPolicyType, new Date()));
  }

  @Post(':policyType')
  @RequirePermissions('tenant_settings:write')
  async setPolicy(
    @Req() req: RequestWithTokenClaims,
    @Param('id') id: string,
    @Param('policyType') policyType: string,
    @Body() body: { policyGroupId?: string; definition: Record<string, unknown> },
  ): Promise<Policy> {
    this.assertPlatformAdmin(req);
    this.assertKnownPolicyType(policyType);
    const claims = req.tokenClaims!;
    return this.tenantContext.run({ tenantId: id }, async () => {
      const lineageInput = {
        policyType: policyType as ConfigPolicyType,
        orgUnitId: null,
        definition: body.definition,
        effectiveFrom: new Date(),
      };
      const after = body.policyGroupId
        ? await this.policies.supersede(body.policyGroupId, lineageInput)
        : await this.policies.createLineage(lineageInput);
      await this.auditByPlatformAdmin(claims, id, `${policyType}.changed`, null, { definition: after.definition });
      return after;
    });
  }

  private assertKnownPolicyType(policyType: string): void {
    if (!POLICY_TYPES.includes(policyType as ConfigPolicyType)) {
      throw new ForbiddenException(`Unknown or unsupported policy type "${policyType}".`);
    }
  }

  /** Records under the *target* tenant (`id`), not the calling platform admin's own tenant — same reasoning `provisionAdmin`'s own audit call documents. Must run inside the `tenantContext.run()` block, not after it. */
  private async auditByPlatformAdmin(
    claims: RequestWithTokenClaims['tokenClaims'],
    tenantId: string,
    action: string,
    beforeState: Record<string, unknown> | null,
    afterState: Record<string, unknown> | null,
  ): Promise<void> {
    await this.auditLog.record({
      tenantId,
      actorId: claims!.sub,
      actorType: AuditActorType.USER,
      action,
      resourceType: 'tenant_settings',
      resourceId: tenantId,
      beforeState,
      afterState,
      aiRationale: null,
    });
  }
}
