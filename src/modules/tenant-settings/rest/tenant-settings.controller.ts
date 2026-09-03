import { Body, Controller, Get, Post, Put, Req, UseGuards } from '@nestjs/common';
import { AccessTokenGuard, RequestWithTokenClaims } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';
import { AuditLogRepository } from '../../audit/repositories/audit-log.repository';
import { AuditActorType } from '../../audit/entities/audit-actor-type.enum';
import { TenantSettingsService } from '../tenant-settings.service';
import { TenantSettingsView } from './tenant-settings.view';
import { UpdateEmailSettingsDto } from '../dto/update-email-settings.dto';
import { UpdateSecurityPolicyDto } from '../dto/update-security-policy.dto';
import { UpdateGeneralSettingsDto } from '../dto/update-general-settings.dto';
import { UpdateSelfIdentificationSettingsDto } from '../dto/update-self-identification-settings.dto';
import { UpdateWfmDefaultsDto } from '../dto/update-wfm-defaults.dto';
import { UpdateWorkforceDefaultsDto } from '../dto/update-workforce-defaults.dto';

/**
 * `/v1/tenant-settings` — email/SMTP, security policy, and general/branding
 * config, one row per tenant. Three separate `PUT` endpoints rather than one
 * combined body, so the audit trail records "changed email config" distinct
 * from "changed security policy" distinct from "changed branding" — a real
 * difference in a compliance review, same reasoning as
 * `TenantManagementController`'s own audit-per-mutation shape.
 */
@Controller('v1/tenant-settings')
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class TenantSettingsController {
  constructor(
    private readonly settings: TenantSettingsService,
    private readonly auditLog: AuditLogRepository,
  ) {}

  @Get()
  @RequirePermissions('tenant_settings:read')
  async get(): Promise<TenantSettingsView> {
    return this.settings.getSettings();
  }

  @Put('email')
  @RequirePermissions('tenant_settings:write')
  async updateEmail(
    @Req() req: RequestWithTokenClaims,
    @Body() dto: UpdateEmailSettingsDto,
  ): Promise<TenantSettingsView> {
    const before = await this.settings.getSettings();
    const after = await this.settings.updateEmailSettings(dto);
    await this.audit(req, 'tenant_settings.email_updated', before, after);
    return after;
  }

  /** Real SMTP connection test (nodemailer `verify()`) — see `TenantSettingsService.testEmailConnection`'s own doc comment. Read-only, no persistence, so `tenant_settings:read` is enough. */
  @Post('email/test-connection')
  @RequirePermissions('tenant_settings:read')
  async testEmailConnection(): Promise<{ success: boolean; message: string }> {
    return this.settings.testEmailConnection();
  }

  @Put('security')
  @RequirePermissions('tenant_settings:write')
  async updateSecurity(
    @Req() req: RequestWithTokenClaims,
    @Body() dto: UpdateSecurityPolicyDto,
  ): Promise<TenantSettingsView> {
    const before = await this.settings.getSettings();
    const after = await this.settings.updateSecurityPolicy(dto);
    await this.audit(req, 'tenant_settings.security_policy_updated', before, after);
    return after;
  }

  @Put('general')
  @RequirePermissions('tenant_settings:write')
  async updateGeneral(
    @Req() req: RequestWithTokenClaims,
    @Body() dto: UpdateGeneralSettingsDto,
  ): Promise<TenantSettingsView> {
    const before = await this.settings.getSettings();
    const after = await this.settings.updateGeneralSettings(dto);
    await this.audit(req, 'tenant_settings.general_updated', before, after);
    return after;
  }

  @Put('self-identification')
  @RequirePermissions('tenant_settings:write')
  async updateSelfIdentification(
    @Req() req: RequestWithTokenClaims,
    @Body() dto: UpdateSelfIdentificationSettingsDto,
  ): Promise<TenantSettingsView> {
    const before = await this.settings.getSettings();
    const after = await this.settings.updateSelfIdentification(dto);
    await this.audit(req, 'tenant_settings.self_identification_updated', before, after);
    return after;
  }

  @Put('wfm-defaults')
  @RequirePermissions('tenant_settings:write')
  async updateWfmDefaults(
    @Req() req: RequestWithTokenClaims,
    @Body() dto: UpdateWfmDefaultsDto,
  ): Promise<TenantSettingsView> {
    const before = await this.settings.getSettings();
    const after = await this.settings.updateWfmDefaults(dto);
    await this.audit(req, 'tenant_settings.wfm_defaults_updated', before, after);
    return after;
  }

  @Put('workforce-defaults')
  @RequirePermissions('tenant_settings:write')
  async updateWorkforceDefaults(
    @Req() req: RequestWithTokenClaims,
    @Body() dto: UpdateWorkforceDefaultsDto,
  ): Promise<TenantSettingsView> {
    const before = await this.settings.getSettings();
    const after = await this.settings.updateWorkforceDefaults(dto);
    await this.audit(req, 'tenant_settings.workforce_defaults_updated', before, after);
    return after;
  }

  private async audit(
    req: RequestWithTokenClaims,
    action: string,
    before: TenantSettingsView,
    after: TenantSettingsView,
  ): Promise<void> {
    const claims = req.tokenClaims!;
    await this.auditLog.record({
      tenantId: claims.tenant_id,
      actorId: claims.sub,
      actorType: AuditActorType.USER,
      action,
      resourceType: 'tenant_settings',
      resourceId: after.id,
      beforeState: { ...before },
      afterState: { ...after },
      aiRationale: null,
    });
  }
}
