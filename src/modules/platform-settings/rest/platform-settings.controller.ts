import { Body, Controller, ForbiddenException, Get, Logger, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { AccessTokenGuard, RequestWithTokenClaims } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';
import { PlatformSettingsService } from '../services/platform-settings.service';
import { PlatformFeatureFlagDefaultsService } from '../services/platform-feature-flag-defaults.service';
import { PlatformSettingsView } from './platform-settings.view';
import { UpdatePlatformSmtpSettingsDto } from '../dto/update-platform-smtp-settings.dto';
import { UpdatePlatformSecurityBaselineDto } from '../dto/update-platform-security-baseline.dto';
import { SetFeatureFlagDefaultDto } from '../dto/set-feature-flag-default.dto';
import { PlatformFeatureFlagDefault } from '../entities/platform-feature-flag-default.entity';

/**
 * Genuinely platform-wide config — no `:id`/tenant in this URL at all, no
 * `tenantContext.run()` needed (unlike `TenantConfigAdminController`, which
 * this controller otherwise mirrors: hard `platform_admin` role check,
 * `tenant_settings:read`/`write` permissions reused rather than minting a
 * new `platform_settings:*` permission — the hard role check is the real
 * gate here, same substitution `TenantConfigAdminController`'s own doc
 * comment already documents).
 *
 * Known gap: `AuditLogRepository.record()` requires a non-null `tenant_id`
 * (no platform-wide sentinel tenant exists in this codebase), so writes
 * here are only `Logger.log()`'d, not written to a queryable `audit_log`
 * row — disclosed, not silently glossed over.
 */
@Controller('v1/platform-settings')
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class PlatformSettingsController {
  private readonly logger = new Logger(PlatformSettingsController.name);

  constructor(
    private readonly settings: PlatformSettingsService,
    private readonly featureFlagDefaults: PlatformFeatureFlagDefaultsService,
  ) {}

  private assertPlatformAdmin(req: RequestWithTokenClaims): void {
    if (!req.tokenClaims!.roles.includes('platform_admin')) {
      throw new ForbiddenException('Only a platform admin may view or change platform-wide settings.');
    }
  }

  @Get('smtp')
  @RequirePermissions('tenant_settings:read')
  async getSmtp(@Req() req: RequestWithTokenClaims): Promise<PlatformSettingsView> {
    this.assertPlatformAdmin(req);
    return this.settings.getSmtpSettings();
  }

  @Put('smtp')
  @RequirePermissions('tenant_settings:write')
  async updateSmtp(@Req() req: RequestWithTokenClaims, @Body() dto: UpdatePlatformSmtpSettingsDto): Promise<PlatformSettingsView> {
    this.assertPlatformAdmin(req);
    const result = await this.settings.updateSmtpSettings(dto);
    this.logger.log(`platform_admin ${req.tokenClaims!.sub} updated platform-wide SMTP settings`);
    return result;
  }

  @Post('smtp/test-connection')
  @RequirePermissions('tenant_settings:read')
  async testSmtp(@Req() req: RequestWithTokenClaims): Promise<{ success: boolean; message: string }> {
    this.assertPlatformAdmin(req);
    return this.settings.testSmtpConnection();
  }

  @Get('security-baseline')
  @RequirePermissions('tenant_settings:read')
  async getSecurityBaseline(@Req() req: RequestWithTokenClaims): Promise<PlatformSettingsView> {
    this.assertPlatformAdmin(req);
    return this.settings.getSecurityBaseline();
  }

  @Put('security-baseline')
  @RequirePermissions('tenant_settings:write')
  async updateSecurityBaseline(
    @Req() req: RequestWithTokenClaims,
    @Body() dto: UpdatePlatformSecurityBaselineDto,
  ): Promise<PlatformSettingsView> {
    this.assertPlatformAdmin(req);
    const result = await this.settings.updateSecurityBaseline(dto);
    this.logger.log(`platform_admin ${req.tokenClaims!.sub} updated the platform-wide security baseline`);
    return result;
  }

  @Get('feature-flag-defaults')
  @RequirePermissions('tenant_settings:read')
  async listFeatureFlagDefaults(@Req() req: RequestWithTokenClaims): Promise<PlatformFeatureFlagDefault[]> {
    this.assertPlatformAdmin(req);
    return this.featureFlagDefaults.listAll();
  }

  @Put('feature-flag-defaults/:flagKey')
  @RequirePermissions('tenant_settings:write')
  async setFeatureFlagDefault(
    @Req() req: RequestWithTokenClaims,
    @Param('flagKey') flagKey: string,
    @Body() dto: SetFeatureFlagDefaultDto,
  ): Promise<PlatformFeatureFlagDefault> {
    this.assertPlatformAdmin(req);
    const result = await this.featureFlagDefaults.setDefault(flagKey, dto.enabled);
    this.logger.log(`platform_admin ${req.tokenClaims!.sub} set platform default for flag "${flagKey}" to ${dto.enabled}`);
    return result;
  }
}
