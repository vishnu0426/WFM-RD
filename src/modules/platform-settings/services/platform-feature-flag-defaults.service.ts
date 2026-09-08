import { Injectable } from '@nestjs/common';
import { PlatformFeatureFlagDefaultsRepository } from '../repositories/platform-feature-flag-defaults.repository';
import { PlatformFeatureFlagDefault } from '../entities/platform-feature-flag-default.entity';

@Injectable()
export class PlatformFeatureFlagDefaultsService {
  constructor(private readonly repository: PlatformFeatureFlagDefaultsRepository) {}

  /** Consulted by `FeatureFlagsService.isEnabled()` only when a tenant has no per-tenant row at all for this key. */
  async getDefault(flagKey: string): Promise<PlatformFeatureFlagDefault | null> {
    return this.repository.findByKey(flagKey);
  }

  async listAll(): Promise<PlatformFeatureFlagDefault[]> {
    return this.repository.findAll();
  }

  async setDefault(flagKey: string, enabled: boolean): Promise<PlatformFeatureFlagDefault> {
    return this.repository.setEnabled(flagKey, enabled);
  }
}
