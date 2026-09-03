import { Injectable } from '@nestjs/common';
import { RedisService } from '../../../common/redis/redis.service';

const KEY_PREFIX = 'token:revoked:';

/**
 * §5.2's "revocation endpoint/blacklist path backed by Redis" for the
 * otherwise-stateless short-lived access token. Keyed by `jti`, TTL set to
 * the token's *remaining* lifetime (not a fixed value) - once the token
 * would have expired anyway, the blacklist entry is redundant and Redis
 * reclaims the memory on its own; a revoked-but-already-expired token can
 * never need to be checked again.
 */
@Injectable()
export class TokenRevocationService {
  constructor(private readonly redis: RedisService) {}

  async revoke(jti: string, expiresAt: Date): Promise<void> {
    const ttlSeconds = Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
    await this.redis.setWithTtl(KEY_PREFIX + jti, '1', ttlSeconds);
  }

  async isRevoked(jti: string): Promise<boolean> {
    return this.redis.exists(KEY_PREFIX + jti);
  }
}
