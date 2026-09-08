import { Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import { PLATFORM_SETTINGS_SINGLETON_ID, PlatformSettings } from '../entities/platform-settings.entity';

const UNIQUE_VIOLATION = '23505';

/**
 * `platform_settings` is global (no `tenant_id`, no RLS) — plain
 * `DataSource` wrapper, not a `TenantScopedRepository`, matching
 * `SigningKeysRepository`/`PermissionsRepository`'s own doc comments on why.
 */
@Injectable()
export class PlatformSettingsRepository {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Singleton row, materialized lazily on first touch — same "insert on
   * first touch, re-read on a losing race" shape as
   * `TenantSettingsRepository.getOrCreate()`, except keyed by the fixed
   * `PLATFORM_SETTINGS_SINGLETON_ID` rather than "find any row" (there's no
   * tenant_id to build a uniqueness guarantee on for a tenant-less table).
   */
  async getOrCreate(): Promise<PlatformSettings> {
    const repo = this.dataSource.getRepository(PlatformSettings);
    const existing = await repo.findOne({ where: { id: PLATFORM_SETTINGS_SINGLETON_ID } });
    if (existing) {
      return existing;
    }
    try {
      return await repo.save({ id: PLATFORM_SETTINGS_SINGLETON_ID } as PlatformSettings);
    } catch (err) {
      if (err instanceof QueryFailedError && (err as unknown as { code?: string }).code === UNIQUE_VIOLATION) {
        const row = await repo.findOne({ where: { id: PLATFORM_SETTINGS_SINGLETON_ID } });
        if (row) return row;
      }
      throw err;
    }
  }

  async save(settings: PlatformSettings): Promise<PlatformSettings> {
    return this.dataSource.getRepository(PlatformSettings).save(settings);
  }
}
