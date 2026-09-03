import 'reflect-metadata';
import { getMetadataArgsStorage } from 'typeorm';
import { MarketplacePostStatus, MarketplacePostType } from '../../src/marketplace/entities/marketplace-post.entity';
import { MarketplaceClaimStatus } from '../../src/marketplace/entities/marketplace-claim.entity';
import { SwapRequestStatus } from '../../src/marketplace/entities/swap-request.entity';
import { BidRankingMethod } from '../../src/marketplace/entities/bid-opportunity.entity';
import { MarketplaceEngagementScore } from '../../src/marketplace/entities/marketplace-engagement-score.entity';
import { MarketplaceEngagementEventType } from '../../src/marketplace/entities/marketplace-engagement-event.entity';
import { entities } from '../../src/database/entities';

/**
 * Verifies the TypeORM entity classes agree with the §2.1 DDL - catches an
 * entity/migration drift that a TypeScript compile alone would not, same
 * convention as every other service's `test/unit/entities.spec.ts`.
 */
describe('database entities', () => {
  it("registers all eight entities (§2.1's original six plus Phase 7's engagement ledger plus GAP-02's outbox), scoped to the marketplace schema", () => {
    expect(entities).toHaveLength(8);
    const entitySet = new Set<unknown>(entities);
    const tables = getMetadataArgsStorage().tables.filter((t) => entitySet.has(t.target));
    expect(tables).toHaveLength(8);
    for (const table of tables) {
      expect(table.schema).toBe('marketplace');
    }
  });

  it("MarketplacePostType matches §2.1's enum exactly", () => {
    expect(Object.values(MarketplacePostType).sort()).toEqual(['bid', 'open_shift', 'swap'].sort());
  });

  it("MarketplacePostStatus matches §2.1's enum exactly", () => {
    expect(Object.values(MarketplacePostStatus).sort()).toEqual(['cancelled', 'claimed', 'expired', 'open'].sort());
  });

  it("MarketplaceClaimStatus matches §2.1/§2.2 rule 2's enum exactly - pending_validation is distinct from pending_approval", () => {
    expect(Object.values(MarketplaceClaimStatus).sort()).toEqual(
      ['approved', 'pending_approval', 'pending_validation', 'rejected', 'superseded'].sort(),
    );
  });

  it("SwapRequestStatus matches §2.1's enum plus Phase 5's pending_approval (ADR-0089)", () => {
    expect(Object.values(SwapRequestStatus).sort()).toEqual(
      ['accepted', 'cancelled', 'pending', 'pending_approval', 'rejected', 'superseded'].sort(),
    );
  });

  it("BidRankingMethod matches §2.1's enum exactly", () => {
    expect(Object.values(BidRankingMethod).sort()).toEqual(['first_come', 'preference_score', 'seniority'].sort());
  });

  it("MarketplaceEngagementScore's composite PK is exactly (employee_id, tenant_id)", () => {
    const columns = getMetadataArgsStorage()
      .columns.filter((c) => c.target === MarketplaceEngagementScore)
      .filter((c) => c.options.primary)
      .map((c) => c.propertyName)
      .sort();
    expect(columns).toEqual(['employeeId', 'tenantId'].sort());
  });

  it("MarketplaceEngagementEventType matches Phase 7's own scoping decision - only real completion signals, no bid_won yet (ADR-0091)", () => {
    expect(Object.values(MarketplaceEngagementEventType).sort()).toEqual(['claim_approved', 'swap_executed'].sort());
  });
});
