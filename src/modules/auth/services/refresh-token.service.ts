import { Injectable } from '@nestjs/common';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { RedisService } from '../../../common/redis/redis.service';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { RefreshTokensRepository } from '../repositories/refresh-tokens.repository';
import { RefreshToken } from '../entities/refresh-token.entity';
import { RefreshTokenStatus } from '../entities/refresh-token-status.enum';
import { RefreshTokenReusedError } from '../errors/refresh-token-reused.error';
import { InvalidGrantError } from '../errors/invalid-grant.error';

// §3.4: "Refresh token TTL: 30 days sliding, rotated on every use."
export const REFRESH_TOKEN_TTL_DAYS = 30;
const REDIS_KEY_PREFIX = 'session:refresh:token:';

export interface IssueRefreshTokenInput {
  tenantId: string;
  userId: string;
  clientId: string;
  amr: string[];
  authTime: Date;
  scope: string;
}

export interface RefreshTokenResult {
  rawToken: string;
  record: RefreshToken;
}

/**
 * ADR-0025: family_id + generation reuse detection, Postgres as source of
 * truth, Redis as a fast-path cache keyed by token hash (§3.4's "current-
 * valid-token pointer in Redis for fast lookup") - a cache miss (cold Redis,
 * eviction, first request after a Redis restart) always falls back to the
 * Postgres CAS in `RefreshTokensRepository.rotate`, so correctness never
 * depends on the cache being warm.
 */
@Injectable()
export class RefreshTokenService {
  constructor(
    private readonly refreshTokensRepository: RefreshTokensRepository,
    private readonly redis: RedisService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async issue(input: IssueRefreshTokenInput): Promise<RefreshTokenResult> {
    const rawToken = this.generateRawToken();
    const tokenHash = this.hash(rawToken);
    const expiresAt = this.expiryFromNow();
    const record = await this.refreshTokensRepository.createFamily({
      tenantId: input.tenantId,
      familyId: randomUUID(),
      generation: 1,
      userId: input.userId,
      clientId: input.clientId,
      tokenHash,
      amr: input.amr,
      authTime: input.authTime,
      scope: input.scope,
      expiresAt,
    });
    await this.cache(record, tokenHash);
    return { rawToken, record };
  }

  /**
   * Rotates a presented refresh token. Throws `RefreshTokenReusedError`
   * (family already revoked as a side effect) if the token was not the
   * family's current generation - see the class doc comment and
   * `RefreshTokensRepository.rotate`'s CAS.
   */
  async rotate(presentedRawToken: string): Promise<RefreshTokenResult> {
    const tokenHash = this.hash(presentedRawToken);
    const current = await this.lookup(tokenHash);
    if (!current) {
      throw new InvalidGrantError('Refresh token is invalid.');
    }
    // Defense-in-depth: a Redis cache hit bypasses the RLS filter a Postgres
    // fallback query would apply, so the tenant match is checked explicitly
    // here rather than relying on it falling out of the CAS WHERE clause
    // downstream (see the class doc comment).
    if (current.tenantId !== this.tenantContext.requireTenantId()) {
      throw new InvalidGrantError('Refresh token is invalid.');
    }
    if (current.expiresAt.getTime() < Date.now()) {
      throw new InvalidGrantError('Refresh token has expired.');
    }
    if (current.status !== RefreshTokenStatus.ACTIVE) {
      // Already rotated or revoked - this presentation is a replay.
      await this.refreshTokensRepository.revokeFamily(current.familyId, 'reuse_detected');
      await this.redis.del(REDIS_KEY_PREFIX + tokenHash);
      throw new RefreshTokenReusedError();
    }

    const newRawToken = this.generateRawToken();
    const newTokenHash = this.hash(newRawToken);
    const rotated = await this.refreshTokensRepository.rotate(current.id, {
      tenantId: current.tenantId,
      familyId: current.familyId,
      generation: current.generation + 1,
      userId: current.userId,
      clientId: current.clientId,
      tokenHash: newTokenHash,
      amr: current.amr,
      authTime: current.authTime,
      scope: current.scope,
      expiresAt: this.expiryFromNow(),
    });

    await this.redis.del(REDIS_KEY_PREFIX + tokenHash);
    if (!rotated) {
      // Lost the CAS race to a concurrent rotate of the same token - treat
      // identically to reuse (see RefreshTokensRepository.rotate's doc comment).
      await this.refreshTokensRepository.revokeFamily(current.familyId, 'concurrent_rotation_conflict');
      throw new RefreshTokenReusedError();
    }

    await this.cache(rotated, newTokenHash);
    return { rawToken: newRawToken, record: rotated };
  }

  /** Read-only lookup for `POST /oauth/introspect` (RFC 7662) - never mutates, unlike `rotate()`. */
  async peekActive(rawToken: string, tenantId: string): Promise<RefreshToken | null> {
    const current = await this.lookup(this.hash(rawToken));
    if (!current || current.tenantId !== tenantId) {
      return null;
    }
    if (current.status !== RefreshTokenStatus.ACTIVE || current.expiresAt.getTime() < Date.now()) {
      return null;
    }
    return current;
  }

  async revokeByRawToken(rawToken: string, reason: string): Promise<void> {
    const tokenHash = this.hash(rawToken);
    const current = await this.lookup(tokenHash);
    if (!current) {
      return;
    }
    await this.refreshTokensRepository.revokeFamily(current.familyId, reason);
    await this.redis.del(REDIS_KEY_PREFIX + tokenHash);
  }

  /**
   * §5.7's forced mid-session revocation (SCIM deactivation, admin-initiated
   * "log out everywhere"). Purges every affected family's Redis fast-path
   * entry too - without this, a cached "active" token from a different
   * session than whichever one triggered this call would keep rotating
   * successfully via the cache-hit path until its own TTL (up to 30 days)
   * expired, even though Postgres already says `revoked` (see
   * `RefreshTokensRepository.revokeAllForUser`'s own doc comment).
   */
  async revokeAllSessionsForUser(userId: string, reason: string): Promise<void> {
    const revokedTokenHashes = await this.refreshTokensRepository.revokeAllForUser(userId, reason);
    await Promise.all(revokedTokenHashes.map((tokenHash) => this.redis.del(REDIS_KEY_PREFIX + tokenHash)));
  }

  private async lookup(tokenHash: string): Promise<RefreshToken | null> {
    const cached = await this.redis.get(REDIS_KEY_PREFIX + tokenHash);
    if (cached) {
      const parsed = JSON.parse(cached) as RefreshToken;
      return { ...parsed, expiresAt: new Date(parsed.expiresAt), authTime: new Date(parsed.authTime) };
    }
    return this.refreshTokensRepository.findByTokenHash(tokenHash);
  }

  private async cache(record: RefreshToken, tokenHash: string): Promise<void> {
    const ttlSeconds = Math.max(1, Math.ceil((record.expiresAt.getTime() - Date.now()) / 1000));
    await this.redis.setWithTtl(REDIS_KEY_PREFIX + tokenHash, JSON.stringify(record), ttlSeconds);
  }

  private generateRawToken(): string {
    return randomBytes(32).toString('base64url');
  }

  private hash(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }

  private expiryFromNow(): Date {
    return new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  }
}
