import { Injectable } from '@nestjs/common';
import { FeatureFlagsRepository } from '../repositories/feature-flags.repository';
import { PlatformFeatureFlagDefaultsService } from '../../platform-settings/services/platform-feature-flag-defaults.service';

/** §0.5's `bulk_import_destructive` flag key - the one this phase actually gates. */
export const BULK_IMPORT_DESTRUCTIVE_FLAG = 'bulk_import_destructive';

@Injectable()
export class FeatureFlagsService {
  constructor(
    private readonly featureFlagsRepository: FeatureFlagsRepository,
    private readonly platformDefaults: PlatformFeatureFlagDefaultsService,
  ) {}

  /**
   * An explicit per-tenant row (even `enabled: false`) always wins. Only
   * when the tenant has NO row at all for this key does the platform-wide
   * default (Platform Settings gap-fix) apply - still fails closed end to
   * end if neither exists.
   */
  async isEnabled(flagKey: string): Promise<boolean> {
    const flag = await this.featureFlagsRepository.findByKey(flagKey);
    if (flag) {
      return flag.enabled;
    }
    const platformDefault = await this.platformDefaults.getDefault(flagKey);
    return platformDefault?.enabled ?? false;
  }

  async setEnabled(flagKey: string, enabled: boolean): Promise<boolean> {
    const flag = await this.featureFlagsRepository.setEnabled(flagKey, enabled);
    return flag.enabled;
  }
}
