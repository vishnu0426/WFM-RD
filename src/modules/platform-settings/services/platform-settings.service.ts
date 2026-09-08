import { Injectable } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import { PlatformSettingsRepository } from '../repositories/platform-settings.repository';
import { toPlatformSettingsView, PlatformSettingsView } from '../rest/platform-settings.view';
import { UpdatePlatformSmtpSettingsDto } from '../dto/update-platform-smtp-settings.dto';
import { UpdatePlatformSecurityBaselineDto } from '../dto/update-platform-security-baseline.dto';

@Injectable()
export class PlatformSettingsService {
  constructor(private readonly repository: PlatformSettingsRepository) {}

  async getSmtpSettings(): Promise<PlatformSettingsView> {
    return toPlatformSettingsView(await this.repository.getOrCreate());
  }

  async updateSmtpSettings(dto: UpdatePlatformSmtpSettingsDto): Promise<PlatformSettingsView> {
    const current = await this.repository.getOrCreate();
    const { smtpPassword, ...rest } = dto;
    Object.assign(current, rest);
    // Omitted/undefined password leaves the stored value untouched — same
    // convention as TenantSettingsService.updateEmailSettings.
    if (smtpPassword) {
      current.smtpPassword = smtpPassword;
    }
    const saved = await this.repository.save(current);
    return toPlatformSettingsView(saved);
  }

  /** Same real nodemailer `verify()` test as `TenantSettingsService.testEmailConnection`, against the platform row instead of a tenant row. */
  async testSmtpConnection(): Promise<{ success: boolean; message: string }> {
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

  async getSecurityBaseline(): Promise<PlatformSettingsView> {
    return toPlatformSettingsView(await this.repository.getOrCreate());
  }

  async updateSecurityBaseline(dto: UpdatePlatformSecurityBaselineDto): Promise<PlatformSettingsView> {
    const current = await this.repository.getOrCreate();
    Object.assign(current, dto);
    const saved = await this.repository.save(current);
    return toPlatformSettingsView(saved);
  }
}
