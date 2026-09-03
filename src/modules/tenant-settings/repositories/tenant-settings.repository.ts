import { Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantScopedRepository } from '../../../common/tenant/tenant-scoped.repository';
import { TenantSettings } from '../entities/tenant-settings.entity';

const UNIQUE_VIOLATION = '23505';

@Injectable()
export class TenantSettingsRepository extends TenantScopedRepository<TenantSettings> {
  constructor(dataSource: DataSource, tenantContext: TenantContextService) {
    super(dataSource, TenantSettings, tenantContext);
  }

  /**
   * Settings are a singleton row per tenant with sensible column defaults —
   * there's no separate provisioning step, so the row materializes lazily
   * on first touch. Two concurrent first-touches both racing to insert is
   * rare (this is an admin-only surface) but handled: the loser's unique
   * violation on `idx_tenant_settings_tenant_id` is caught and turned into a
   * plain re-read of the winner's row rather than a 500.
   */
  async getOrCreate(): Promise<TenantSettings> {
    const existing = await this.findOne({ where: {} });
    if (existing) {
      return existing;
    }
    try {
      return await this.save({} as TenantSettings);
    } catch (err) {
      if (err instanceof QueryFailedError && (err as unknown as { code?: string }).code === UNIQUE_VIOLATION) {
        const row = await this.findOne({ where: {} });
        if (row) return row;
      }
      throw err;
    }
  }
}
