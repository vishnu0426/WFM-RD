import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { RedisService } from '../../../common/redis/redis.service';

const KEY_PREFIX = 'webauthn:verified-session:';
const TTL_SECONDS = 300; // 5 minutes - long enough to complete the /oauth/authorize call right after the ceremony, no longer.

export interface VerifiedWebAuthnSession {
  tenantId: string;
  userId: string;
}

/**
 * The bridge between `WebAuthnModule`'s ceremony endpoints and
 * `OAuthController.authorize` (§5.4: "WebAuthn/Passkeys as a first-class
 * MFA/primary-auth option alongside SSO"). `WebAuthnService` calls `issue()`
 * after a successful assertion verification; `OAuthController` calls
 * `consume()` in place of `PasswordAuthService.authenticate()` when the
 * request carries a `webauthn_session_token` instead of `username`/`password`
 * - both paths converge on the same authorization-code issuance logic.
 * Lives in `AuthModule` (not `WebAuthnModule`) specifically so
 * `OAuthController` can depend on it without depending on the ceremony
 * logic itself, avoiding a module cycle (`WebAuthnModule` depends on
 * `AuthModule`, never the reverse).
 */
@Injectable()
export class WebAuthnSessionService {
  constructor(private readonly redis: RedisService) {}

  async issue(session: VerifiedWebAuthnSession): Promise<string> {
    const token = randomBytes(24).toString('base64url');
    await this.redis.setWithTtl(KEY_PREFIX + token, JSON.stringify(session), TTL_SECONDS);
    return token;
  }

  /** Single-use: consuming deletes the session immediately, verified session tokens are not reusable. */
  async consume(token: string): Promise<VerifiedWebAuthnSession | null> {
    const key = KEY_PREFIX + token;
    const raw = await this.redis.get(key);
    if (!raw) {
      return null;
    }
    await this.redis.del(key);
    return JSON.parse(raw) as VerifiedWebAuthnSession;
  }
}
