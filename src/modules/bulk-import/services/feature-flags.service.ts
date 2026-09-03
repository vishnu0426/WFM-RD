import { Injectable } from '@nestjs/common';
import { FeatureFlagsRepository } from '../repositories/feature-flags.repository';

/** §0.5's `bulk_import_destructive` flag key - the one this phase actually gates. */
export const BULK_IMPORT_DESTRUCTIVE_FLAG = 'bulk_import_destructive';

@Injectable()
export class FeatureFlagsService {
  constructor(private readonly featureFlagsRepository: FeatureFlagsRepository) {}

  /** Unset = disabled (fail closed - a new flag key defaults to off, not on). */
  async isEnabled(flagKey: string): Promise<boolean> {
    const flag = await this.featureFlagsRepository.findByKey(flagKey);
    return flag?.enabled ?? false;
  }

  async setEnabled(flagKey: string, enabled: boolean): Promise<boolean> {
    const flag = await this.featureFlagsRepository.setEnabled(flagKey, enabled);
    return flag.enabled;
  }
}
