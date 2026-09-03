import { Injectable } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import { TenantSettingsRepository } from './repositories/tenant-settings.repository';
import { toTenantSettingsView, TenantSettingsView } from './rest/tenant-settings.view';
import { UpdateEmailSettingsDto } from './dto/update-email-settings.dto';
import { UpdateSecurityPolicyDto } from './dto/update-security-policy.dto';
import { UpdateGeneralSettingsDto } from './dto/update-general-settings.dto';
import { UpdateSelfIdentificationSettingsDto } from './dto/update-self-identification-settings.dto';
import { UpdateWfmDefaultsDto } from './dto/update-wfm-defaults.dto';
import { UpdateWorkforceDefaultsDto } from './dto/update-workforce-defaults.dto';

@Injectable()
export class TenantSettingsService {
  constructor(private readonly repository: TenantSettingsRepository) {}

  async getSettings(): Promise<TenantSettingsView> {
    return toTenantSettingsView(await this.repository.getOrCreate());
  }

  async updateEmailSettings(dto: UpdateEmailSettingsDto): Promise<TenantSettingsView> {
    const current = await this.repository.getOrCreate();
    const { smtpPassword, ...rest } = dto;
    Object.assign(current, rest);
    // Omitted/undefined password leaves the stored value untouched — only a
    // real, non-empty value overwrites it (see the DTO's own doc comment).
    if (smtpPassword) {
      current.smtpPassword = smtpPassword;
    }
    const saved = await this.repository.save(current);
    return toTenantSettingsView(saved);
  }

  async updateSecurityPolicy(dto: UpdateSecurityPolicyDto): Promise<TenantSettingsView> {
    const current = await this.repository.getOrCreate();
    Object.assign(current, dto);
    const saved = await this.repository.save(current);
    return toTenantSettingsView(saved);
  }

  async updateGeneralSettings(dto: UpdateGeneralSettingsDto): Promise<TenantSettingsView> {
    const current = await this.repository.getOrCreate();
    Object.assign(current, dto);
    const saved = await this.repository.save(current);
    return toTenantSettingsView(saved);
  }

  async updateSelfIdentification(dto: UpdateSelfIdentificationSettingsDto): Promise<TenantSettingsView> {
    const current = await this.repository.getOrCreate();
    current.selfIdentificationProperties = dto.properties;
    const saved = await this.repository.save(current);
    return toTenantSettingsView(saved);
  }

  async updateWfmDefaults(dto: UpdateWfmDefaultsDto): Promise<TenantSettingsView> {
    const current = await this.repository.getOrCreate();
    Object.assign(current, dto);
    const saved = await this.repository.save(current);
    return toTenantSettingsView(saved);
  }

  async updateWorkforceDefaults(dto: UpdateWorkforceDefaultsDto): Promise<TenantSettingsView> {
    const current = await this.repository.getOrCreate();
    Object.assign(current, dto);
    const saved = await this.repository.save(current);
    return toTenantSettingsView(saved);
  }

  /**
   * System Configuration gap-fix: a real connection test, same posture as
   * `TenantIdentityProvidersController.testConnection` (SSO) — genuinely
   * connects to and authenticates against the SMTP server via nodemailer's
   * own `verify()`, without sending an email. Uses the currently-*saved*
   * config (not an unsaved draft), matching how the SSO test-connection
   * endpoint only ever tests an already-created provider.
   */
  async testEmailConnection(): Promise<{ success: boolean; message: string }> {
    const settings = await this.repository.getOrCreate();
    if (!settings.smtpHost || !settings.smtpPort) {
      return { success: false, message: 'SMTP host and port are not configured yet.' };
    }
    const transport = createTransport({
      host: settings.smtpHost,
      port: settings.smtpPort,
      secure: settings.smtpUseTls,
      auth: settings.smtpUsername ? { user: settings.smtpUsername, pass: settings.smtpPassword ?? undefined } : undefined,
      connectionTimeout: 10_000,
    });
    try {
      await transport.verify();
      return { success: true, message: `Connected to ${settings.smtpHost}:${settings.smtpPort} successfully.` };
    } catch (err) {
      return { success: false, message: `Connection failed: ${(err as Error).message}` };
    }
  }
}
