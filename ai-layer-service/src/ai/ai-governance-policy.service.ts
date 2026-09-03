import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { withTenantConnection } from '../database/with-tenant-connection';
import { AiGovernancePolicy, AiAutonomyLevel } from './entities/ai-governance-policy.entity';
import { AiGovernancePolicyHistory } from './entities/ai-governance-policy-history.entity';

/**
 * §6.1's `updateGovernancePolicy` - write side of the resolution
 * `AiGovernancePolicyResolverService` reads. Upserts on `(tenant_id,
 * action_type)` (ADR-0113's own unique constraint) - a tenant
 * reconfiguring an `action_type` calls this again, never a separate
 * "create vs. update" distinction. RBAC-gated since Phase 8
 * (`ai_governance_policy:write`, docs/adr/0130) - this mutation controls
 * whether an action can execute *without* a human in the loop, at least as
 * sensitive as a stored credential.
 *
 * Every real change is versioned into `ai_governance_policy_history`
 * (ADR-0132, SCD Type 2) by a database trigger, never by this service -
 * `getHistory` only ever reads what the trigger already wrote.
 */
@Injectable()
export class AiGovernancePolicyService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async update(
    tenantId: string,
    actionType: string,
    autonomyLevel: AiAutonomyLevel,
    riskThresholdConfig: Record<string, unknown>,
    updatedBy: string | null,
  ): Promise<AiGovernancePolicy> {
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const existing = await manager.findOne(AiGovernancePolicy, { where: { tenantId, actionType } });
      const now = new Date();
      if (existing) {
        existing.autonomyLevel = autonomyLevel;
        existing.riskThresholdConfig = riskThresholdConfig;
        existing.updatedAt = now;
        existing.updatedBy = updatedBy ?? existing.updatedBy;
        return manager.save(AiGovernancePolicy, existing);
      }
      const created = manager.create(AiGovernancePolicy, {
        id: randomUUID(),
        tenantId,
        actionType,
        autonomyLevel,
        riskThresholdConfig,
        updatedAt: now,
        updatedBy,
      });
      return manager.save(AiGovernancePolicy, created);
    });
  }

  /** ADR-0132: newest-first version history for one tenant's `action_type`, including the currently-open version (`validTo: null`). Empty if the tenant has never configured this `action_type` at all. */
  async getHistory(tenantId: string, actionType: string): Promise<AiGovernancePolicyHistory[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager
        .getRepository(AiGovernancePolicyHistory)
        .createQueryBuilder('h')
        .where('h.tenant_id = :tenantId', { tenantId })
        .andWhere('h.action_type = :actionType', { actionType })
        .orderBy('h.valid_from', 'DESC')
        .getMany(),
    );
  }
}
