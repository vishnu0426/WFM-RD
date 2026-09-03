import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { RedisService } from '../../../common/redis/redis.service';

const KEY_PREFIX = 'sso:pending:';
const TTL_SECONDS = 600; // 10 minutes - long enough for a real IdP login page round trip, no longer.

export interface PendingSsoRequest {
  tenantId: string;
  providerId: string;
  clientId: string; // OAuthClient's internal uuid, not its public client_id string
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  originalState: string | null;
  nonce: string | null;
}

/**
 * State that has to survive the round trip to an external IdP and back
 * (SAML's RelayState / OIDC's `state`) - the original `/oauth/authorize`-
 * shaped request parameters `SsoController.login` received, keyed by a
 * random request id neither protocol's IdP ever needs to interpret, just
 * echo back. Redis, not Postgres: this is ephemeral session state with a
 * 10-minute lifetime, not a durable record (§1).
 */
@Injectable()
export class SsoLoginService {
  constructor(private readonly redis: RedisService) {}

  async createPendingRequest(input: PendingSsoRequest): Promise<string> {
    const requestId = randomBytes(24).toString('base64url');
    await this.redis.setWithTtl(KEY_PREFIX + requestId, JSON.stringify(input), TTL_SECONDS);
    return requestId;
  }

  /** Single-use: consuming deletes the pending request immediately. */
  async consumePendingRequest(requestId: string): Promise<PendingSsoRequest | null> {
    const key = KEY_PREFIX + requestId;
    const raw = await this.redis.get(key);
    if (!raw) {
      return null;
    }
    await this.redis.del(key);
    return JSON.parse(raw) as PendingSsoRequest;
  }
}
