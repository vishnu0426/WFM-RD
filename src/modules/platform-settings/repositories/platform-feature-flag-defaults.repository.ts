import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PlatformFeatureFlagDefault } from '../entities/platform-feature-flag-default.entity';

/** Global (no tenant_id, no RLS) — plain `DataSource` wrapper, same posture as `PlatformSettingsRepository`. */
@Injectable()
export class PlatformFeatureFlagDefaultsRepository {
  constructor(private readonly dataSource: DataSource) {}

  async findByKey(flagKey: string): Promise<PlatformFeatureFlagDefault | null> {
    return this.dataSource.getRepository(PlatformFeatureFlagDefault).findOne({ where: { flagKey } });
  }

  async findAll(): Promise<PlatformFeatureFlagDefault[]> {
    return this.dataSource.getRepository(PlatformFeatureFlagDefault).find({ order: { flagKey: 'ASC' } });
  }

  async setEnabled(flagKey: string, enabled: boolean): Promise<PlatformFeatureFlagDefault> {
    const repo = this.dataSource.getRepository(PlatformFeatureFlagDefault);
    const existing = await repo.findOne({ where: { flagKey } });
    if (existing) {
      existing.enabled = enabled;
      return repo.save(existing);
    }
    return repo.save({ flagKey, enabled } as PlatformFeatureFlagDefault);
  }
}
