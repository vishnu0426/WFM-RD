import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { RedisService } from '../../../common/redis/redis.service';

const KEY_PREFIX = 'webauthn:challenge:';
const TTL_SECONDS = 300; // 5 minutes - matches the ceremony's own default timeout (60s) with margin for slow clients.

export interface PendingChallenge {
  tenantId: string;
  userId: string;
  challenge: string;
}

/**
 * Redis-backed WebAuthn ceremony state (§1: session cache only, never
 * system of record - the durable artifact of a *successful* ceremony is a
 * `webauthn_credentials` row, not this). One challenge per
 * registration-options or authentication-options call, single-use, keyed by
 * an opaque id the client round-trips back when it calls the matching
 * "verify" endpoint.
 */
@Injectable()
export class WebAuthnChallengeService {
  constructor(private readonly redis: RedisService) {}

  async create(pending: PendingChallenge): Promise<string> {
    const challengeId = randomBytes(24).toString('base64url');
    await this.redis.setWithTtl(KEY_PREFIX + challengeId, JSON.stringify(pending), TTL_SECONDS);
    return challengeId;
  }

  async consume(challengeId: string): Promise<PendingChallenge | null> {
    const key = KEY_PREFIX + challengeId;
    const raw = await this.redis.get(key);
    if (!raw) {
      return null;
    }
    await this.redis.del(key);
    return JSON.parse(raw) as PendingChallenge;
  }
}
