import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Pool } from 'pg';
import { MIGRATOR_PG_POOL } from '../database/migrator-pool.provider';
import { BidService } from './bid.service';
import { MetricsService } from '../common/metrics/metrics.service';

/**
 * §5.1/§8: nothing in §3.1 names a `closeBidOpportunity` mutation - closing
 * happens on its own once `biddingWindowEnd` passes, the same "the window
 * ending is the trigger, not a human/API action" framing `BidOpportunity`'s
 * own fields imply. Cross-tenant by nature (one tick checks every tenant's
 * expired opportunities), same shape as attendance-leave-service's
 * `LeaveCarryoverJobService` (ADR-0080) - uses the migrator pool to find
 * candidates (RLS would otherwise scope a normal query to one bound
 * tenant), then calls `BidService.closeBidOpportunity` per opportunity,
 * which does its real work through the normal tenant-scoped path.
 *
 * "Unclosed" is derived, not a stored status column: an opportunity with
 * at least one `Bid` whose `rank_position IS NULL` hasn't been ranked yet
 * (§2.1's own "nullable until close" framing is the signal) - avoids a
 * `BidOpportunity.status` column purely for this job's own bookkeeping.
 * `EVERY_MINUTE` is a reasonable local-dev/test default, not a considered
 * production interval - same explicit-assumption posture as every other
 * job's own placeholder poll interval in this platform.
 */
@Injectable()
export class BidCloseSweepService {
  private readonly logger = new Logger(BidCloseSweepService.name);

  constructor(
    @Inject(MIGRATOR_PG_POOL) private readonly migratorPool: Pool,
    private readonly bidService: BidService,
    private readonly metrics: MetricsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async sweepTick(): Promise<void> {
    let candidates: Array<{ tenant_id: string; id: string }>;
    try {
      const result = await this.migratorPool.query<{ tenant_id: string; id: string }>(
        `SELECT DISTINCT bo.tenant_id, bo.id
         FROM marketplace.bid_opportunity bo
         JOIN marketplace.bid b ON b.bid_opportunity_id = bo.id AND b.rank_position IS NULL
         WHERE bo.bidding_window_end < now()`,
      );
      candidates = result.rows;
    } catch (err) {
      this.metrics.bidCloseSweepTicksTotal.inc({ outcome: 'query_failed' });
      this.logger.error(`Bid close sweep query failed: ${(err as Error).message}`);
      return;
    }
    this.metrics.bidCloseSweepTicksTotal.inc({ outcome: 'ok' });

    for (const candidate of candidates) {
      try {
        await this.bidService.closeBidOpportunity(candidate.tenant_id, candidate.id);
        this.metrics.bidCloseSweepOpportunitiesTotal.inc({ outcome: 'closed' });
      } catch (err) {
        this.metrics.bidCloseSweepOpportunitiesTotal.inc({ outcome: 'failed' });
        this.logger.error(
          `Failed to close bid opportunity ${candidate.id} (tenant ${candidate.tenant_id}): ${(err as Error).message}`,
        );
      }
    }
  }
}
