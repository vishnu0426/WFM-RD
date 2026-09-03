import { Injectable } from '@nestjs/common';
import { OAuthTokenExchangeFailedError } from './errors/oauth-callback.errors';

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number | null;
  tokenType: string | null;
}

/**
 * §1: "Standard OAuth 2.1 authorization code flow... reusing the same
 * token-handling discipline (rotation, secure storage via Vault) as Module
 * 01's own OAuth implementation." Module 01's own OAuth code is an
 * authorization *server* (issuing tokens to clients, `src/modules/auth/`),
 * not a client of external providers, and its `openid-client` dependency
 * targets full OIDC discovery - a poor fit for providers like Genesys/NICE
 * CXone/Avaya that expose a plain OAuth 2.0 token endpoint without a
 * `.well-known` discovery document. This is a real, generic RFC 6749 §4.1.3
 * authorization-code exchange instead - the *discipline* §1 asks to reuse
 * (never logging the secret, Vault-only storage, real HTTP to a real
 * endpoint) rather than the specific library, since the library doesn't
 * fit this module's actual provider shapes.
 *
 * Verified live against a real (generic, not vendor-specific) local OAuth
 * token-endpoint test double - see the Phase 2 design doc. This module has
 * no real registered developer credentials for any of the 10 named
 * providers to test against directly; the exchange logic itself is
 * provider-agnostic RFC 6749, so a generic test double exercises the exact
 * same code path a real provider would.
 */
@Injectable()
export class OAuthTokenExchangeService {
  async exchangeAuthorizationCode(
    tokenEndpoint: string,
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri: string,
  ): Promise<OAuthTokenSet> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    });

    let response: Response;
    try {
      response = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(),
      });
    } catch (err) {
      throw new OAuthTokenExchangeFailedError((err as Error).message);
    }

    if (!response.ok) {
      throw new OAuthTokenExchangeFailedError(`HTTP ${response.status}: ${await this.safeBody(response)}`);
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = (await response.json()) as Record<string, unknown>;
    } catch (err) {
      throw new OAuthTokenExchangeFailedError(`malformed response body: ${(err as Error).message}`);
    }

    if (typeof parsed.access_token !== 'string') {
      throw new OAuthTokenExchangeFailedError('response body is missing a string "access_token"');
    }

    return {
      accessToken: parsed.access_token,
      refreshToken: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : null,
      expiresInSeconds: typeof parsed.expires_in === 'number' ? parsed.expires_in : null,
      tokenType: typeof parsed.token_type === 'string' ? parsed.token_type : null,
    };
  }

  private async safeBody(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return '<unreadable body>';
    }
  }
}
