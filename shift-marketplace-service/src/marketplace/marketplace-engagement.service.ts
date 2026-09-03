import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { withTenantConnection } from '../database/with-tenant-connection';
import { MarketplaceEngagementEventType } from './entities/marketplace-engagement-event.entity';

export interface RecordEngagementEventInput {
  tenantId: string;
  employeeId: string;
  eventType: MarketplaceEngagementEventType;
  /** The `MarketplaceClaim`/`SwapRequest` id that earned this - the ledger's own traceability column. */
  referenceId: string;
}

export interface RecordEngagementEventResult {
  points: number;
  streakDays: number;
  badges: string[];
  newlyAwardedBadges: string[];
}

interface ScoreRow {
  points: number;
  streak_days: number;
  badges: string[];
  last_engagement_date: string | null;
}

/**
 * §2.2 rule 3/ADR-0091 badge rules - a small, fixed set, not tenant-
 * configurable (unlike claim-attempt limits/auto-approval, nothing in this
 * module's prompt asks for per-tenant badge tuning, and inventing that
 * configurability here would be solving a problem nobody asked for). Point
 * values per event type *are* configurable (`MARKETPLACE_POINTS_*`
 * env vars) - the numbers themselves are an explicit, tunable product
 * decision the same way every other placeholder default in this service is.
 */
const STREAK_BADGE_THRESHOLDS: ReadonlyArray<{ days: number; badge: string }> = [
  { days: 7, badge: 'week_streak' },
  { days: 30, badge: 'month_streak' },
];

const POINTS_BADGE_THRESHOLDS: ReadonlyArray<{ points: number; badge: string }> = [
  { points: 100, badge: 'century_club' },
  { points: 500, badge: 'marketplace_champion' },
];

/** Awarded once, the first time this employee ever reaches this event type - `awardBadges`'s set-membership check is what makes this "only once" free, no separate counter needed. */
const FIRST_EVENT_BADGE: Record<MarketplaceEngagementEventType, string> = {
  [MarketplaceEngagementEventType.CLAIM_APPROVED]: 'first_fill',
  [MarketplaceEngagementEventType.SWAP_EXECUTED]: 'team_player',
};

/**
 * §2.2 rule 3/Phase 7 (ADR-0091): points/streaks/badges as real, auditable,
 * queryable data - every change here also writes a
 * `MarketplaceEngagementEvent` ledger row in the same transaction, never
 * just the running-totals table alone.
 *
 * Only `ClaimApproved`/`SwapExecuted` are real, verified "a shift actually
 * got filled" completion signals in this service (all three reach
 * `MarketplaceEventPublisherService`'s own shared call sites). A bid's
 * winner earns the same `CLAIM_APPROVED` event as any other claim once
 * approved (ADR-0159, `BidService.convertWinningBidToClaim`) - there's no
 * separate `bid_won` event type because, from this ledger's own point of
 * view, "a claim I created got approved" is the complete, identical
 * signal regardless of which mechanism created the claim.
 */
@Injectable()
export class MarketplaceEngagementService {
  private readonly pointsByEventType: Record<MarketplaceEngagementEventType, number>;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    config: ConfigService,
  ) {
    this.pointsByEventType = {
      [MarketplaceEngagementEventType.CLAIM_APPROVED]: Number(
        config.get<string>('MARKETPLACE_POINTS_CLAIM_APPROVED', '10'),
      ),
      [MarketplaceEngagementEventType.SWAP_EXECUTED]: Number(
        config.get<string>('MARKETPLACE_POINTS_SWAP_EXECUTED', '5'),
      ),
    };
  }

  async recordEvent(input: RecordEngagementEventInput): Promise<RecordEngagementEventResult> {
    return withTenantConnection(this.dataSource, input.tenantId, (manager) => this.applyEvent(manager, input));
  }

  private async applyEvent(
    manager: EntityManager,
    input: RecordEngagementEventInput,
  ): Promise<RecordEngagementEventResult> {
    const { tenantId, employeeId, eventType, referenceId } = input;

    await manager.query(
      `INSERT INTO marketplace.marketplace_engagement_score (employee_id, tenant_id, points, streak_days, badges)
       VALUES ($1, $2, 0, 0, '[]'::jsonb)
       ON CONFLICT (employee_id, tenant_id) DO NOTHING`,
      [employeeId, tenantId],
    );
    // `FOR UPDATE` - two genuinely concurrent approvals for the same
    // employee (different claims/swaps, different posts) must never both
    // compute their new totals off the same stale snapshot (the classic
    // lost-update anomaly a plain SELECT-then-UPDATE would allow); this
    // serializes them on the row, same as every other "read current state,
    // compute, write back" path in this service that can't express itself
    // as a single atomic SQL statement (unlike `ClaimAttemptRateLimiterService`'s
    // pure-SQL upsert, badge-set membership logic doesn't fit in one CASE
    // expression).
    const rows: ScoreRow[] = await manager.query(
      `SELECT points, streak_days, badges, last_engagement_date
       FROM marketplace.marketplace_engagement_score
       WHERE employee_id = $1 AND tenant_id = $2
       FOR UPDATE`,
      [employeeId, tenantId],
    );
    const row = rows[0];

    const today = new Date().toISOString().slice(0, 10);
    const pointsDelta = this.pointsByEventType[eventType];
    const newPoints = row.points + pointsDelta;
    const newStreak = nextStreak(row.last_engagement_date, today, row.streak_days);
    const { badges: newBadges, newlyAwarded } = awardBadges(row.badges, eventType, newPoints, newStreak);

    await manager.query(
      `UPDATE marketplace.marketplace_engagement_score
       SET points = $3, streak_days = $4, badges = $5::jsonb, last_engagement_date = $6
       WHERE employee_id = $1 AND tenant_id = $2`,
      [employeeId, tenantId, newPoints, newStreak, JSON.stringify(newBadges), today],
    );

    await manager.query(
      `INSERT INTO marketplace.marketplace_engagement_event
         (id, tenant_id, employee_id, event_type, reference_id, points_delta, streak_days_after, badges_awarded, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now())`,
      [
        randomUUID(),
        tenantId,
        employeeId,
        eventType,
        referenceId,
        pointsDelta,
        newStreak,
        JSON.stringify(newlyAwarded),
      ],
    );

    return { points: newPoints, streakDays: newStreak, badges: newBadges, newlyAwardedBadges: newlyAwarded };
  }
}

/**
 * UTC calendar dates throughout (`YYYY-MM-DD`) - same no-per-tenant-
 * timezone-concept placeholder posture every other date-bucketing decision
 * in this platform already takes; a real per-tenant timezone would change
 * what "consecutive day" means without changing this function's shape.
 */
function nextStreak(lastEngagementDate: string | null, today: string, currentStreak: number): number {
  if (!lastEngagementDate) {
    return 1;
  }
  if (lastEngagementDate === today) {
    // A second qualifying event on the same day extends nothing further -
    // the streak already counted today.
    return currentStreak === 0 ? 1 : currentStreak;
  }
  const diffDays = Math.round((Date.parse(today) - Date.parse(lastEngagementDate)) / (24 * 60 * 60 * 1000));
  return diffDays === 1 ? currentStreak + 1 : 1;
}

function awardBadges(
  existing: string[],
  eventType: MarketplaceEngagementEventType,
  points: number,
  streakDays: number,
): { badges: string[]; newlyAwarded: string[] } {
  const set = new Set(existing);
  const newlyAwarded: string[] = [];

  const maybeAward = (badge: string): void => {
    if (!set.has(badge)) {
      set.add(badge);
      newlyAwarded.push(badge);
    }
  };

  maybeAward(FIRST_EVENT_BADGE[eventType]);
  for (const { days, badge } of STREAK_BADGE_THRESHOLDS) {
    if (streakDays >= days) {
      maybeAward(badge);
    }
  }
  for (const { points: threshold, badge } of POINTS_BADGE_THRESHOLDS) {
    if (points >= threshold) {
      maybeAward(badge);
    }
  }

  return { badges: Array.from(set), newlyAwarded };
}
