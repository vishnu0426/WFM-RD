import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { withTenantConnection } from '../database/with-tenant-connection';
import { ClaimAttemptRateLimitExceededError } from './errors/claim-attempt-rate-limit-exceeded.error';

interface TenantLimitOverride {
  limit?: number;
  windowSeconds?: number;
}

/**
 * §5.2: a claim-attempt-specific limit, distinct from Module 01's own
 * tenant-level Envoy token-bucket (§3.4 there) - that one protects the
 * whole API gateway from raw request volume; this one exists specifically
 * to catch scripted rapid-fire claiming *of the marketplace's own claim
 * action*, which a generic per-tenant request quota wouldn't distinguish
 * from a legitimate burst of unrelated traffic.
 *
 * Persists on `MarketplaceEngagementScore.claimAttemptCountWindow`/
 * `claimAttemptWindowStart` (§2.1's own fields, shipped in Phase 1's
 * migration specifically for this) rather than Redis or a new table - this
 * counter needs to survive exactly as long as engagement data does, and
 * reusing the existing per-(employee,tenant) row avoids a second place to
 * look up "this employee's own marketplace standing."
 *
 * Defaults (10 attempts / 60s) and the tenant-override map are the same
 * flat-env-config placeholder posture as `TenantMarketplacePolicyService` -
 * no tenant-settings service exists anywhere in this platform to hook a
 * real per-tenant configuration into yet.
 */
@Injectable()
export class ClaimAttemptRateLimiterService {
  private readonly defaultLimit: number;
  private readonly defaultWindowSeconds: number;
  private readonly overridesByTenantId: ReadonlyMap<string, TenantLimitOverride>;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    config: ConfigService,
  ) {
    this.defaultLimit = Number(config.get<string>('MARKETPLACE_CLAIM_ATTEMPT_LIMIT', '10'));
    this.defaultWindowSeconds = Number(config.get<string>('MARKETPLACE_CLAIM_ATTEMPT_WINDOW_SECONDS', '60'));
    this.overridesByTenantId = this.parseOverrides(
      config.get<string>('MARKETPLACE_CLAIM_ATTEMPT_LIMIT_OVERRIDES', '{}'),
    );
  }

  private parseOverrides(raw: string): ReadonlyMap<string, TenantLimitOverride> {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return new Map(Object.entries(parsed as Record<string, TenantLimitOverride>));
      }
    } catch {
      // Fall through to an empty map - a malformed override config should
      // never take down the whole limiter, just fall back to the defaults.
    }
    return new Map();
  }

  private limitsFor(tenantId: string): { limit: number; windowSeconds: number } {
    const override = this.overridesByTenantId.get(tenantId);
    return {
      limit: override?.limit ?? this.defaultLimit,
      windowSeconds: override?.windowSeconds ?? this.defaultWindowSeconds,
    };
  }

  /**
   * Checked *before* any real work (§5.2/§4's own "fast-fail" spirit
   * extended to abuse, not just contention) - a rate-limited caller never
   * touches Redis, never reaches a DB write, never reaches Module 04's
   * gRPC guardrail check. Read-only (this method itself never increments
   * anything) - `recordFailedAttempt` is the only writer, called only
   * after a real outcome is known.
   */
  async assertNotRateLimited(tenantId: string, employeeId: string): Promise<void> {
    const { limit, windowSeconds } = this.limitsFor(tenantId);
    // RLS-scoped like every other query in this service - a plain
    // `DataSource.query` bypassing `withTenantConnection` would never bind
    // `app.current_tenant_id`, and RLS fails *closed* on an unset GUC
    // (this SELECT would silently return zero rows, not an error).
    const rows = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.query(
        `SELECT claim_attempt_count_window, claim_attempt_window_start
         FROM marketplace.marketplace_engagement_score
         WHERE employee_id = $1 AND tenant_id = $2`,
        [employeeId, tenantId],
      ),
    );
    const row = rows[0] as
      { claim_attempt_count_window: number | null; claim_attempt_window_start: Date | null } | undefined;
    if (!row || row.claim_attempt_window_start === null) {
      return;
    }
    const windowElapsedSeconds = (Date.now() - new Date(row.claim_attempt_window_start).getTime()) / 1000;
    if (windowElapsedSeconds > windowSeconds) {
      return; // window has expired - the next recordFailedAttempt() will reset it
    }
    if ((row.claim_attempt_count_window ?? 0) >= limit) {
      throw new ClaimAttemptRateLimitExceededError(Math.ceil(windowSeconds - windowElapsedSeconds));
    }
  }

  /**
   * Only ever called for an attempt that did *not* result in a real
   * claim (§5.2: "failed/rejected claim attempts still count... but
   * successful claims... do not") - `ClaimOpenShiftService` is the sole
   * caller, and it never calls this for a claim that reached
   * `pending_approval`/`approved`. A single atomic `INSERT ... ON
   * CONFLICT` (not a read-then-write) so two genuinely concurrent failed
   * attempts from the same employee can never lose an increment to each
   * other.
   */
  async recordFailedAttempt(tenantId: string, employeeId: string): Promise<void> {
    const { windowSeconds } = this.limitsFor(tenantId);
    await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.query(
        `INSERT INTO marketplace.marketplace_engagement_score
         (employee_id, tenant_id, points, streak_days, badges, claim_attempt_count_window, claim_attempt_window_start)
       VALUES ($1, $2, 0, 0, '[]'::jsonb, 1, now())
       ON CONFLICT (employee_id, tenant_id) DO UPDATE SET
         claim_attempt_count_window = CASE
           WHEN marketplace.marketplace_engagement_score.claim_attempt_window_start IS NULL
             OR now() - marketplace.marketplace_engagement_score.claim_attempt_window_start > ($3 || ' seconds')::interval
           THEN 1
           ELSE marketplace.marketplace_engagement_score.claim_attempt_count_window + 1
         END,
         claim_attempt_window_start = CASE
           WHEN marketplace.marketplace_engagement_score.claim_attempt_window_start IS NULL
             OR now() - marketplace.marketplace_engagement_score.claim_attempt_window_start > ($3 || ' seconds')::interval
           THEN now()
           ELSE marketplace.marketplace_engagement_score.claim_attempt_window_start
         END`,
        [employeeId, tenantId, String(windowSeconds)],
      ),
    );
  }
}
