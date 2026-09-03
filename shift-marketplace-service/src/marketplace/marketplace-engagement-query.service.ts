import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { withTenantConnection } from '../database/with-tenant-connection';
import { MarketplaceEngagementScore } from './entities/marketplace-engagement-score.entity';
import { MarketplaceEngagementEvent } from './entities/marketplace-engagement-event.entity';

const EVENT_HISTORY_LIMIT = 50;

/**
 * §2.2 rule 3/Phase 7 (ADR-0091): the read side of "queryable data" -
 * `MarketplaceEngagementService` only ever writes; this is the only place
 * either table gets read back out, mirroring `MarketplacePostQueryService`'s
 * own read-only, no-business-logic shape.
 */
@Injectable()
export class MarketplaceEngagementQueryService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async findScore(tenantId: string, employeeId: string): Promise<MarketplaceEngagementScore | null> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.findOne(MarketplaceEngagementScore, { where: { employeeId, tenantId } }),
    );
  }

  /** Most recent first - a fixed cap, not an open-ended history query, same "no unbounded list" posture as every paginated surface elsewhere in this platform. */
  async findEvents(tenantId: string, employeeId: string): Promise<MarketplaceEngagementEvent[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.find(MarketplaceEngagementEvent, {
        where: { employeeId, tenantId },
        order: { createdAt: 'DESC' },
        take: EVENT_HISTORY_LIMIT,
      }),
    );
  }
}
