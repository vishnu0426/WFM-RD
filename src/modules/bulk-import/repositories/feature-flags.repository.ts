import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantScopedRepository } from '../../../common/tenant/tenant-scoped.repository';
import { withTenantTransaction } from '../../../common/tenant/with-tenant-transaction';
import { FeatureFlag } from '../entities/feature-flag.entity';

@Injectable()
export class FeatureFlagsRepository extends TenantScopedRepository<FeatureFlag> {
  constructor(dataSource: DataSource, tenantContext: TenantContextService) {
    super(dataSource, FeatureFlag, tenantContext);
  }

  async findByKey(flagKey: string): Promise<FeatureFlag | null> {
    return this.findOne({ where: { flagKey } as never });
  }

  async setEnabled(flagKey: string, enabled: boolean): Promise<FeatureFlag> {
    const existing = await this.findByKey(flagKey);
    if (existing) {
      await this.update({ flagKey } as never, { enabled, updatedAt: new Date() } as never);
      return { ...existing, enabled };
    }
    return this.save({ flagKey, enabled, updatedAt: new Date() } as FeatureFlag);
  }

  /**
   * Platform Admin's cross-tenant Feature Flags view: bypasses the
   * inherited `find()` (which always forces `tenantId` from the ambient
   * context into the `where` clause, so it can never return more than one
   * tenant's row) with its own raw query - same "own query, not the
   * inherited tenant-forced one" precedent `OrgUnitsRepository.
   * findSubtree()` already sets. Correct only when the ambient
   * `isPlatformAdmin` is genuinely true (see `1700000037000-
   * FeatureFlagsPlatformAdminBypass.ts`'s RLS clause) - for anyone else it
   * harmlessly degrades to "just my own tenant's row," the same property
   * `TenantsRepository.findAll()` already has.
   */
  async findAllForKey(flagKey: string): Promise<FeatureFlag[]> {
    const tenantId = this.tenantContext.requireTenantId();
    const isPlatformAdmin = this.tenantContext.isPlatformAdmin();
    return withTenantTransaction(this.dataSource, { tenantId, isPlatformAdmin }, (manager) =>
      manager.getRepository(FeatureFlag).find({ where: { flagKey } as never }),
    );
  }
}
