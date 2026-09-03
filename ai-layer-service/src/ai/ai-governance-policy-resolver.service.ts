import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { withTenantConnection } from '../database/with-tenant-connection';
import { AiGovernancePolicy, AiAutonomyLevel } from './entities/ai-governance-policy.entity';

/** §3's sentinel for "this tenant's own broader/default category row" (ADR-0114) - an ordinary `action_type` value, not schema-special. */
export const DEFAULT_ACTION_TYPE = 'default';

/** §3's safety net: never a more permissive level for an action_type nobody has configured. */
export const PLATFORM_DEFAULT_AUTONOMY_LEVEL = AiAutonomyLevel.SUGGEST_ONLY;

export interface ResolvedGovernance {
  autonomyLevel: AiAutonomyLevel;
  riskThresholdConfig: Record<string, unknown>;
}

/**
 * §3's three-tier resolution order (ADR-0114): exact `action_type` match →
 * this tenant's own `'default'` row → the hardcoded platform default. The
 * third tier is a constant, never a database row - see ADR-0113/0114 for
 * why this module has no nullable-tenant-id "platform default" table the
 * way Module 08's `compliance_rule` does.
 */
@Injectable()
export class AiGovernancePolicyResolverService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async resolve(tenantId: string, actionType: string): Promise<ResolvedGovernance> {
    const exact = await this.findByActionType(tenantId, actionType);
    if (exact) {
      return { autonomyLevel: exact.autonomyLevel, riskThresholdConfig: exact.riskThresholdConfig };
    }
    if (actionType !== DEFAULT_ACTION_TYPE) {
      const fallback = await this.findByActionType(tenantId, DEFAULT_ACTION_TYPE);
      if (fallback) {
        return { autonomyLevel: fallback.autonomyLevel, riskThresholdConfig: fallback.riskThresholdConfig };
      }
    }
    return { autonomyLevel: PLATFORM_DEFAULT_AUTONOMY_LEVEL, riskThresholdConfig: {} };
  }

  private async findByActionType(tenantId: string, actionType: string): Promise<AiGovernancePolicy | null> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.findOne(AiGovernancePolicy, { where: { tenantId, actionType } }),
    );
  }
}
