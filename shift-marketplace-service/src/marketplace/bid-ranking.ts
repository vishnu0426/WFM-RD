import { BidRankingMethod } from './entities/bid-opportunity.entity';

export interface RankableBid {
  id: string;
  employeeId: string;
  submittedAt: Date;
  /** For `preference_score`: the bidder's own submitted score (`SubmitBidInput.preferenceScore`, stored at submission time). Unused by the other two methods. */
  rankScore: string | null;
}

export interface RankedBid {
  id: string;
  rankScore: string | null;
  rankPosition: number;
  rankExplanation: Record<string, unknown>;
}

/**
 * §5.1's own instruction: "the specific fields depend on ranking_method,
 * define the shape per method explicitly." Single-winner semantics
 * throughout (rank 1 is "the winner," matching every other post_type in
 * this module being a 1:1 shift-to-employee mechanism) - `cutoffValue`/
 * `cutoffScore`/`cutoffSubmittedAt` is uniformly "what it took to win,"
 * shown to every bidder regardless of their own position, per the source
 * spec's own example (`your_position: 6` still gets told `cutoff_value:
 * "7 years"` - the value that actually won).
 *
 * Pure, deterministic given its inputs (no `Date.now()`/`Math.random()`
 * inside) - `asOf` is passed in explicitly by the caller (the close
 * sweep), the same "explicit as-of timestamp, never an implicit clock
 * read" discipline `FairnessConfig.is_undesirable`/every other pure
 * ranking-adjacent function in this platform already follows.
 */
export function computeRankings(
  method: BidRankingMethod,
  bids: readonly RankableBid[],
  context: { asOf: Date; hireDateByEmployeeId?: ReadonlyMap<string, string> },
): RankedBid[] {
  switch (method) {
    case BidRankingMethod.FIRST_COME:
      return rankByFirstCome(bids);
    case BidRankingMethod.PREFERENCE_SCORE:
      return rankByPreferenceScore(bids);
    case BidRankingMethod.SENIORITY:
      return rankBySeniority(bids, context.hireDateByEmployeeId ?? new Map(), context.asOf);
  }
}

function rankByFirstCome(bids: readonly RankableBid[]): RankedBid[] {
  const sorted = [...bids].sort((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime());
  const cutoffSubmittedAt = sorted[0]?.submittedAt.toISOString() ?? null;
  return sorted.map((bid, index) => ({
    id: bid.id,
    rankScore: null,
    rankPosition: index + 1,
    rankExplanation: {
      method: BidRankingMethod.FIRST_COME,
      yourSubmittedAt: bid.submittedAt.toISOString(),
      cutoffSubmittedAt,
      yourPosition: index + 1,
      totalBidders: sorted.length,
    },
  }));
}

function rankByPreferenceScore(bids: readonly RankableBid[]): RankedBid[] {
  const sorted = [...bids].sort((a, b) => scoreOf(b) - scoreOf(a));
  const cutoffScore = sorted.length > 0 ? scoreOf(sorted[0]) : null;
  return sorted.map((bid, index) => ({
    id: bid.id,
    rankScore: bid.rankScore,
    rankPosition: index + 1,
    rankExplanation: {
      method: BidRankingMethod.PREFERENCE_SCORE,
      yourScore: bid.rankScore === null ? null : scoreOf(bid),
      cutoffScore,
      yourPosition: index + 1,
      totalBidders: sorted.length,
    },
  }));
}

function scoreOf(bid: RankableBid): number {
  return bid.rankScore === null ? -Infinity : Number(bid.rankScore);
}

const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000;

function rankBySeniority(
  bids: readonly RankableBid[],
  hireDateByEmployeeId: ReadonlyMap<string, string>,
  asOf: Date,
): RankedBid[] {
  const withYears = bids.map((bid) => {
    const hireDate = hireDateByEmployeeId.get(bid.employeeId);
    const years = hireDate ? (asOf.getTime() - new Date(hireDate).getTime()) / MS_PER_YEAR : null;
    return { bid, years };
  });
  // Known-seniority bidders first (most senior wins), sorted descending by
  // years of service; bidders whose hire date this snapshot didn't resolve
  // (left the org unit's roster between bidding and close, or a transient
  // gap) sort last, in original submission order - never fabricated a
  // seniority value for them.
  const sorted = [...withYears].sort((a, b) => {
    if (a.years === null && b.years === null) return a.bid.submittedAt.getTime() - b.bid.submittedAt.getTime();
    if (a.years === null) return 1;
    if (b.years === null) return -1;
    return b.years - a.years;
  });
  const cutoffValue = sorted.length > 0 ? formatYears(sorted[0].years) : null;
  return sorted.map(({ bid, years }, index) => ({
    id: bid.id,
    rankScore: years === null ? null : years.toFixed(4),
    rankPosition: index + 1,
    rankExplanation: {
      method: BidRankingMethod.SENIORITY,
      yourValue: formatYears(years),
      cutoffValue,
      yourPosition: index + 1,
      totalBidders: sorted.length,
    },
  }));
}

function formatYears(years: number | null): string | null {
  return years === null ? null : `${years.toFixed(1)} years`;
}
