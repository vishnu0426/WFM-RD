/**
 * §2.1's Redis key schema, same `tenant:{tenantId}:<domain>:<entity>:{id}`
 * convention as intraday-service's own `keys.ts`. Kept as a plain function
 * so `MarketplaceRedisService` and its unit tests build the exact same key
 * string without going through a live Redis connection.
 */
export function claimLockKey(tenantId: string, marketplacePostId: string): string {
  return `tenant:${tenantId}:marketplace:claim-lock:${marketplacePostId}`;
}
