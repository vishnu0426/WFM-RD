/**
 * Per-org-unit trigger name, shared by the publish side
 * (`ClaimOpenShiftService`, and later `SwapRequestService`/`BidService`)
 * and the subscribe side (`MarketplacePostResolver`) so they can never
 * drift apart - same pattern as intraday-service's own
 * `subscription-triggers.ts`.
 *
 * Keyed by `orgUnitId`, matching §3.1's own subscription signature
 * (`marketplacePostUpdated(orgUnitId)`) literally - unlike
 * intraday-service's `alertRaised`, which had to fall back to `tenantId`
 * because no payload in that module carried `org_unit_id` at all,
 * `MarketplacePost.orgUnitId` is a real column here (see that entity's own
 * comment on why it was added beyond the source spec's abbreviated DDL).
 */
export function marketplacePostUpdatedTrigger(tenantId: string, orgUnitId: string): string {
  return `marketplacePostUpdated:${tenantId}:${orgUnitId}`;
}
