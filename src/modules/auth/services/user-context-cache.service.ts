import { Injectable } from '@nestjs/common';
import { RedisService } from '../../../common/redis/redis.service';
import { UserContextResolverService, ResolvedUserContext } from '../../identity/services/user-context-resolver.service';

const KEY_PREFIX = 'identity:usercontext:';
// §3.3: "define TTL and cache-invalidation trigger on role/permission
// change." 60s bounds staleness even before anything calls invalidate()
// below - no UserRole/RolePermission mutation API exists yet (that's
// Phase 4's RBAC CRUD surface), so TTL expiry is the only invalidation path
// that actually fires in this phase; `invalidate()` exists now so Phase 4's
// mutations have a call site to wire into on day one instead of retrofitting
// cache invalidation after the fact.
const TTL_SECONDS = 60;

/**
 * Cache-aside in front of `UserContextResolverService`. Every downstream
 * service calls `IdentityService.GetUserContext` once per request (§3.3);
 * this is what keeps that from being one Postgres round trip per request.
 */
@Injectable()
export class UserContextCacheService {
  constructor(
    private readonly redis: RedisService,
    private readonly resolver: UserContextResolverService,
  ) {}

  async get(tenantId: string, userId: string): Promise<ResolvedUserContext> {
    const key = this.cacheKey(tenantId, userId);
    const cached = await this.redis.get(key);
    if (cached) {
      try {
        return JSON.parse(cached) as ResolvedUserContext;
      } catch {
        // Fall through to a fresh resolve on corrupt cache content.
      }
    }
    const resolved = await this.resolver.resolve(userId);
    await this.redis.setWithTtl(key, JSON.stringify(resolved), TTL_SECONDS);
    return resolved;
  }

  async invalidate(tenantId: string, userId: string): Promise<void> {
    await this.redis.del(this.cacheKey(tenantId, userId));
  }

  private cacheKey(tenantId: string, userId: string): string {
    return `${KEY_PREFIX}${tenantId}:${userId}`;
  }
}
