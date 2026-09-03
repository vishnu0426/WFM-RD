import { computeRankings, RankableBid } from '../../../src/marketplace/bid-ranking';
import { BidRankingMethod } from '../../../src/marketplace/entities/bid-opportunity.entity';

function bid(overrides: Partial<RankableBid>): RankableBid {
  return {
    id: 'bid',
    employeeId: 'employee',
    submittedAt: new Date('2026-01-01T00:00:00Z'),
    rankScore: null,
    ...overrides,
  };
}

describe('computeRankings (§5.1)', () => {
  describe('first_come', () => {
    it('ranks purely by submission order, earliest first', () => {
      const bids = [
        bid({ id: 'b1', submittedAt: new Date('2026-01-01T10:00:00Z') }),
        bid({ id: 'b2', submittedAt: new Date('2026-01-01T09:00:00Z') }),
        bid({ id: 'b3', submittedAt: new Date('2026-01-01T11:00:00Z') }),
      ];
      const ranked = computeRankings(BidRankingMethod.FIRST_COME, bids, { asOf: new Date('2026-01-02T00:00:00Z') });

      expect(ranked.find((r) => r.id === 'b2')?.rankPosition).toBe(1);
      expect(ranked.find((r) => r.id === 'b1')?.rankPosition).toBe(2);
      expect(ranked.find((r) => r.id === 'b3')?.rankPosition).toBe(3);
    });

    it("every bid's explanation cites the same cutoff (winner's) submittedAt, regardless of the bid's own position", () => {
      const bids = [
        bid({ id: 'winner', submittedAt: new Date('2026-01-01T09:00:00Z') }),
        bid({ id: 'loser', submittedAt: new Date('2026-01-01T10:00:00Z') }),
      ];
      const ranked = computeRankings(BidRankingMethod.FIRST_COME, bids, { asOf: new Date('2026-01-02T00:00:00Z') });

      const winner = ranked.find((r) => r.id === 'winner')!;
      const loser = ranked.find((r) => r.id === 'loser')!;
      expect(winner.rankExplanation.cutoffSubmittedAt).toBe('2026-01-01T09:00:00.000Z');
      expect(loser.rankExplanation.cutoffSubmittedAt).toBe('2026-01-01T09:00:00.000Z');
      expect(loser.rankExplanation).toMatchObject({ method: 'first_come', yourPosition: 2, totalBidders: 2 });
      expect(winner.rankScore).toBeNull();
    });
  });

  describe('preference_score', () => {
    it('ranks by submitted score descending, highest wins', () => {
      const bids = [
        bid({ id: 'low', rankScore: '3' }),
        bid({ id: 'high', rankScore: '9' }),
        bid({ id: 'mid', rankScore: '5' }),
      ];
      const ranked = computeRankings(BidRankingMethod.PREFERENCE_SCORE, bids, { asOf: new Date() });

      expect(ranked.find((r) => r.id === 'high')?.rankPosition).toBe(1);
      expect(ranked.find((r) => r.id === 'mid')?.rankPosition).toBe(2);
      expect(ranked.find((r) => r.id === 'low')?.rankPosition).toBe(3);
      const low = ranked.find((r) => r.id === 'low')!;
      expect(low.rankExplanation).toMatchObject({
        method: 'preference_score',
        yourScore: 3,
        cutoffScore: 9,
        totalBidders: 3,
      });
    });
  });

  describe('seniority', () => {
    it('ranks by years of service descending (earliest hire date wins), computed as of the given close time', () => {
      const bids = [bid({ id: 'junior', employeeId: 'e-junior' }), bid({ id: 'senior', employeeId: 'e-senior' })];
      const hireDateByEmployeeId = new Map([
        ['e-junior', '2024-01-01'],
        ['e-senior', '2018-01-01'],
      ]);
      const asOf = new Date('2026-01-01T00:00:00Z');
      const ranked = computeRankings(BidRankingMethod.SENIORITY, bids, { asOf, hireDateByEmployeeId });

      expect(ranked.find((r) => r.id === 'senior')?.rankPosition).toBe(1);
      expect(ranked.find((r) => r.id === 'junior')?.rankPosition).toBe(2);
      const junior = ranked.find((r) => r.id === 'junior')!;
      expect(junior.rankExplanation).toMatchObject({
        method: 'seniority',
        yourValue: '2.0 years',
        cutoffValue: '8.0 years',
      });
      expect(Number(ranked.find((r) => r.id === 'senior')!.rankScore)).toBeCloseTo(8.0, 1);
    });

    it('never fabricates a seniority value for a bidder whose hire date could not be resolved - sorts them last, flags "unknown"', () => {
      const bids = [bid({ id: 'known', employeeId: 'e-known' }), bid({ id: 'unknown', employeeId: 'e-unknown' })];
      const hireDateByEmployeeId = new Map([['e-known', '2020-01-01']]);
      const ranked = computeRankings(BidRankingMethod.SENIORITY, bids, {
        asOf: new Date('2026-01-01T00:00:00Z'),
        hireDateByEmployeeId,
      });

      const unknown = ranked.find((r) => r.id === 'unknown')!;
      expect(unknown.rankPosition).toBe(2);
      expect(unknown.rankScore).toBeNull();
      expect(unknown.rankExplanation.yourValue).toBeNull();
    });
  });
});
