import { DataSource, EntityManager } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { MarketplaceEngagementService } from '../../../src/marketplace/marketplace-engagement.service';
import { MarketplaceEngagementEventType } from '../../../src/marketplace/entities/marketplace-engagement-event.entity';

const TENANT_ID = 'tenant-1';
const EMPLOYEE_ID = 'employee-1';
const REFERENCE_ID = 'claim-1';

describe('MarketplaceEngagementService (§2.2 rule 3, ADR-0091)', () => {
  let query: jest.Mock;
  let dataSource: Partial<DataSource>;

  function makeConfig(values: Record<string, string> = {}): ConfigService {
    return {
      get: jest.fn((key: string, defaultValue?: string) => values[key] ?? defaultValue),
    } as unknown as ConfigService;
  }

  beforeEach(() => {
    query = jest.fn();
    dataSource = {
      transaction: jest.fn(async (work: (m: EntityManager) => Promise<unknown>) =>
        work({ query } as unknown as EntityManager),
      ) as unknown as DataSource['transaction'],
    };
  });

  // Call order: (0) `withTenantConnection`'s own `set_config` no-op, then
  // inside `applyEvent` - (1) upsert-if-missing, (2) SELECT ... FOR UPDATE,
  // (3) UPDATE, (4) INSERT ledger row. Only call (2) returns rows the
  // service actually reads.
  function primeScoreRow(row: {
    points: number;
    streak_days: number;
    badges: string[];
    last_engagement_date: string | null;
  }): void {
    query
      .mockResolvedValueOnce(undefined) // set_config
      .mockResolvedValueOnce(undefined) // upsert-if-missing
      .mockResolvedValueOnce([row]) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce(undefined) // UPDATE
      .mockResolvedValueOnce(undefined); // INSERT ledger
  }

  it('a first-ever claim_approved event starts points at the configured default, streak at 1, and awards first_fill', async () => {
    primeScoreRow({ points: 0, streak_days: 0, badges: [], last_engagement_date: null });
    const service = new MarketplaceEngagementService(
      dataSource as DataSource,
      makeConfig({ MARKETPLACE_POINTS_CLAIM_APPROVED: '10' }),
    );

    const result = await service.recordEvent({
      tenantId: TENANT_ID,
      employeeId: EMPLOYEE_ID,
      eventType: MarketplaceEngagementEventType.CLAIM_APPROVED,
      referenceId: REFERENCE_ID,
    });

    expect(result.points).toBe(10);
    expect(result.streakDays).toBe(1);
    expect(result.badges).toContain('first_fill');
    expect(result.newlyAwardedBadges).toEqual(['first_fill']);
  });

  it('a swap_executed event uses its own configured point value, distinct from claim_approved', async () => {
    primeScoreRow({ points: 0, streak_days: 0, badges: [], last_engagement_date: null });
    const service = new MarketplaceEngagementService(
      dataSource as DataSource,
      makeConfig({ MARKETPLACE_POINTS_SWAP_EXECUTED: '5' }),
    );

    const result = await service.recordEvent({
      tenantId: TENANT_ID,
      employeeId: EMPLOYEE_ID,
      eventType: MarketplaceEngagementEventType.SWAP_EXECUTED,
      referenceId: REFERENCE_ID,
    });

    expect(result.points).toBe(5);
    expect(result.newlyAwardedBadges).toEqual(['team_player']);
  });

  it('a same-day second event does not extend the streak further', async () => {
    const today = new Date().toISOString().slice(0, 10);
    primeScoreRow({ points: 10, streak_days: 1, badges: ['first_fill'], last_engagement_date: today });
    const service = new MarketplaceEngagementService(dataSource as DataSource, makeConfig());

    const result = await service.recordEvent({
      tenantId: TENANT_ID,
      employeeId: EMPLOYEE_ID,
      eventType: MarketplaceEngagementEventType.CLAIM_APPROVED,
      referenceId: REFERENCE_ID,
    });

    expect(result.streakDays).toBe(1);
    expect(result.newlyAwardedBadges).toEqual([]); // first_fill already awarded
  });

  it('an event on the consecutive calendar day extends the streak by one', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    primeScoreRow({ points: 10, streak_days: 1, badges: ['first_fill'], last_engagement_date: yesterday });
    const service = new MarketplaceEngagementService(dataSource as DataSource, makeConfig());

    const result = await service.recordEvent({
      tenantId: TENANT_ID,
      employeeId: EMPLOYEE_ID,
      eventType: MarketplaceEngagementEventType.CLAIM_APPROVED,
      referenceId: REFERENCE_ID,
    });

    expect(result.streakDays).toBe(2);
  });

  it('an event after a gap of more than one day resets the streak to 1', async () => {
    const longAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    primeScoreRow({ points: 10, streak_days: 6, badges: ['first_fill', 'week_streak'], last_engagement_date: longAgo });
    const service = new MarketplaceEngagementService(dataSource as DataSource, makeConfig());

    const result = await service.recordEvent({
      tenantId: TENANT_ID,
      employeeId: EMPLOYEE_ID,
      eventType: MarketplaceEngagementEventType.CLAIM_APPROVED,
      referenceId: REFERENCE_ID,
    });

    expect(result.streakDays).toBe(1);
  });

  it('reaching a 7-day streak awards week_streak exactly once', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    primeScoreRow({ points: 60, streak_days: 6, badges: ['first_fill'], last_engagement_date: yesterday });
    const service = new MarketplaceEngagementService(dataSource as DataSource, makeConfig());

    const result = await service.recordEvent({
      tenantId: TENANT_ID,
      employeeId: EMPLOYEE_ID,
      eventType: MarketplaceEngagementEventType.CLAIM_APPROVED,
      referenceId: REFERENCE_ID,
    });

    expect(result.streakDays).toBe(7);
    expect(result.newlyAwardedBadges).toEqual(['week_streak']);
  });

  it('crossing 100 points awards century_club', async () => {
    const today = new Date().toISOString().slice(0, 10);
    primeScoreRow({ points: 95, streak_days: 3, badges: ['first_fill'], last_engagement_date: today });
    const service = new MarketplaceEngagementService(
      dataSource as DataSource,
      makeConfig({ MARKETPLACE_POINTS_CLAIM_APPROVED: '10' }),
    );

    const result = await service.recordEvent({
      tenantId: TENANT_ID,
      employeeId: EMPLOYEE_ID,
      eventType: MarketplaceEngagementEventType.CLAIM_APPROVED,
      referenceId: REFERENCE_ID,
    });

    expect(result.points).toBe(105);
    expect(result.newlyAwardedBadges).toEqual(['century_club']);
  });

  it('writes a ledger row capturing the event type, reference id, delta, and resulting streak', async () => {
    primeScoreRow({ points: 0, streak_days: 0, badges: [], last_engagement_date: null });
    const service = new MarketplaceEngagementService(
      dataSource as DataSource,
      makeConfig({ MARKETPLACE_POINTS_CLAIM_APPROVED: '10' }),
    );

    await service.recordEvent({
      tenantId: TENANT_ID,
      employeeId: EMPLOYEE_ID,
      eventType: MarketplaceEngagementEventType.CLAIM_APPROVED,
      referenceId: REFERENCE_ID,
    });

    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining('INSERT INTO marketplace.marketplace_engagement_event'),
      expect.arrayContaining([
        TENANT_ID,
        EMPLOYEE_ID,
        MarketplaceEngagementEventType.CLAIM_APPROVED,
        REFERENCE_ID,
        10,
        1,
      ]),
    );
  });
});
