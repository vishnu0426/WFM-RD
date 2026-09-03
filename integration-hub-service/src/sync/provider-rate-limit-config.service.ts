import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ProviderRateLimitConfig } from '../integrations/entities/provider-rate-limit-config.entity';

/**
 * §5a/ADR-0136: `provider_rate_limit_config` is global reference data, no
 * `tenantId`, no RLS - a plain repository read, not `withTenantConnection`.
 * `agno_integration_hub_app` has `SELECT` only on this table (the
 * migration's own grant); this service never writes to it.
 */
@Injectable()
export class ProviderRateLimitConfigService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async findByProvider(provider: string): Promise<ProviderRateLimitConfig | null> {
    return this.dataSource.getRepository(ProviderRateLimitConfig).findOne({ where: { provider } });
  }
}
