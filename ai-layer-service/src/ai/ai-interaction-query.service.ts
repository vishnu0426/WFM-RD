import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { withTenantConnection } from '../database/with-tenant-connection';
import { AiInteraction, AiInteractionType } from './entities/ai-interaction.entity';

export interface ListAiInteractionsFilter {
  interactionType?: AiInteractionType;
  limit?: number;
  offset?: number;
}

/**
 * `aiInteractions(interactionType, limit, offset)` - the general-purpose,
 * tenant-scoped read `idx_ai_interaction_tenant_type_created_at` was built
 * anticipating (that migration's own doc comment: "§0.5 FinOps: per-tenant
 * AIInteraction volume against a plan/quota") but no resolver ever queried
 * against until now. Every existing read of this entity elsewhere in this
 * service (`ai-recommendation.service.ts`, the five generator services) is
 * a single-row `findOne` by id - this is the only multi-row query.
 */
@Injectable()
export class AiInteractionQueryService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async list(tenantId: string, filter: ListAiInteractionsFilter): Promise<AiInteraction[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) => {
      const qb = manager
        .getRepository(AiInteraction)
        .createQueryBuilder('i')
        .where('i.tenant_id = :tenantId', { tenantId })
        .orderBy('i.created_at', 'DESC')
        .take(filter.limit ?? 50)
        .skip(filter.offset ?? 0);
      if (filter.interactionType) {
        qb.andWhere('i.interaction_type = :interactionType', { interactionType: filter.interactionType });
      }
      return qb.getMany();
    });
  }
}
