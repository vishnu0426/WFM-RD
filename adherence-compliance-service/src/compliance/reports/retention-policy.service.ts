import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';
import { randomUUID } from 'crypto';
import { withTenantConnection } from '../../database/with-tenant-connection';
import { RetentionPolicy } from '../entities/retention-policy.entity';
import { InvalidRetentionYearsError } from '../errors/invalid-retention-years.error';

export interface SetRetentionPolicyInput {
  jurisdiction: string;
  retentionYears: number;
  appliesToReportTypes?: string[];
}

/**
 * §5b's own flagged data-lifecycle gap, closed: `RetentionPolicy` had a
 * real table and a real read path (`ComplianceReportService.resolveRetentionExpiry`,
 * tenant-specific row first, then the platform default, per jurisdiction)
 * since Phase 6, but no write path a tenant could ever reach - only this
 * migration's own seed put a row in the table. `setPolicy` is that missing
 * write path.
 *
 * Upsert on `(tenantId, jurisdiction)`, matching the real partial unique
 * index `InitialComplianceSchema` already created for exactly this shape
 * (`idx_retention_policy_tenant`) - find-then-branch inside the same
 * transaction rather than a raw `ON CONFLICT`, since TypeORM's own
 * `.upsert()` helper has no way to target a *partial* unique index's own
 * `WHERE tenant_id IS NOT NULL` condition, and every row this method ever
 * writes has a concrete `tenantId` (RLS's own `WITH CHECK` rejects a
 * null-tenant write outright), so a plain find-then-branch behaves
 * identically to that partial index for every reachable case.
 *
 * No delete method - `retention_policy` was deliberately never granted
 * `DELETE` (`InitialComplianceSchema`'s own doc comment: "every other
 * table follows this platform's usual no-DELETE convention"). A tenant
 * that wants to stop overriding a jurisdiction has no way to revert to the
 * platform default through this service - a real, disclosed limitation of
 * the schema this phase inherited, not something to route around with a
 * schema change of its own.
 */
@Injectable()
export class RetentionPolicyService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** §5b: tenant-specific overrides first, then the platform default, one row per jurisdiction - same precedence `resolveRetentionExpiry` already reads, exposed here as a real list rather than only used internally. */
  async listPolicies(tenantId: string): Promise<RetentionPolicy[]> {
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const [tenantOwned, platformDefaults] = await Promise.all([
        manager.find(RetentionPolicy, { where: { tenantId }, order: { jurisdiction: 'ASC' } }),
        manager.find(RetentionPolicy, { where: { tenantId: IsNull() }, order: { jurisdiction: 'ASC' } }),
      ]);
      const overriddenJurisdictions = new Set(tenantOwned.map((p) => p.jurisdiction));
      const visiblePlatformDefaults = platformDefaults.filter((p) => !overriddenJurisdictions.has(p.jurisdiction));
      return [...tenantOwned, ...visiblePlatformDefaults].sort((a, b) => a.jurisdiction.localeCompare(b.jurisdiction));
    });
  }

  async setPolicy(tenantId: string, input: SetRetentionPolicyInput): Promise<RetentionPolicy> {
    if (!Number.isInteger(input.retentionYears) || input.retentionYears <= 0) {
      throw new InvalidRetentionYearsError(input.retentionYears);
    }

    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const existing = await manager.findOne(RetentionPolicy, { where: { tenantId, jurisdiction: input.jurisdiction } });
      const appliesToReportTypes = asJsonbValue(
        input.appliesToReportTypes ?? existing?.appliesToReportTypes ?? DEFAULT_REPORT_TYPES,
      );

      if (existing) {
        await manager.update(
          RetentionPolicy,
          { id: existing.id },
          { retentionYears: input.retentionYears, appliesToReportTypes },
        );
        return manager.findOneByOrFail(RetentionPolicy, { id: existing.id });
      }

      const id = randomUUID();
      await manager.insert(RetentionPolicy, {
        id,
        tenantId,
        jurisdiction: input.jurisdiction,
        retentionYears: input.retentionYears,
        appliesToReportTypes,
        createdAt: new Date(),
      });
      return manager.findOneByOrFail(RetentionPolicy, { id });
    });
  }
}

const DEFAULT_REPORT_TYPES = ['adherence_summary', 'overtime_audit', 'rest_period_audit', 'regulator_export'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asJsonbValue(value: string[]): any {
  return value;
}
