import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify, importPKCS8 } from 'jose';
import { SigningKeyService } from './signing-key.service';
import { InvalidGrantError } from '../errors/invalid-grant.error';

/** §3.4's exact JWT access token claim shape. */
export interface AccessTokenClaims {
  iss: string;
  sub: string;
  aud: string;
  tenant_id: string;
  org_unit_id: string | null;
  roles: string[];
  permissions: string[];
  amr: string[];
  auth_time: number;
  jti: string;
  exp: number;
  iat: number;
}

export interface IssueAccessTokenInput {
  userId: string;
  tenantId: string;
  orgUnitId: string | null;
  roles: string[];
  permissions: string[];
  amr: string[];
  authTime: Date;
  /** Defaults to `ACCESS_TOKEN_TTL_SECONDS`. Callers pass the caller's tenant's
   * `TenantSettings.sessionTimeoutMinutes * 60` for real user logins (System
   * Configuration's Session Management setting) — machine tokens
   * (client_credentials) intentionally omit this and keep the fixed global TTL. */
  ttlSeconds?: number;
}

export interface IssueIdTokenInput {
  userId: string;
  tenantId: string;
  clientId: string;
  amr: string[];
  authTime: Date;
  nonce: string | null;
}

// §3.4: "Access token TTL: 10-15 min." Upper-middle of that range.
export const ACCESS_TOKEN_TTL_SECONDS = 720;
export const ID_TOKEN_TTL_SECONDS = 720;

@Injectable()
export class TokenService {
  private readonly issuer: string;
  private readonly audience: string;

  constructor(
    private readonly signingKeyService: SigningKeyService,
    config: ConfigService,
  ) {
    this.issuer = config.get<string>('OIDC_ISSUER', 'https://auth.agno-wfm.local');
    this.audience = config.get<string>('OIDC_AUDIENCE', 'agno-core-api');
  }

  async issueAccessToken(
    input: IssueAccessTokenInput,
  ): Promise<{ token: string; jti: string; claims: AccessTokenClaims; ttlSeconds: number }> {
    const { kid, algorithm, privateKeyPem } = await this.signingKeyService.getActiveSigningMaterial();
    const privateKey = await importPKCS8(privateKeyPem, algorithm);
    const jti = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const ttlSeconds = input.ttlSeconds ?? ACCESS_TOKEN_TTL_SECONDS;
    const claims: AccessTokenClaims = {
      iss: this.issuer,
      sub: input.userId,
      aud: this.audience,
      tenant_id: input.tenantId,
      org_unit_id: input.orgUnitId,
      roles: input.roles,
      permissions: input.permissions,
      amr: input.amr,
      auth_time: Math.floor(input.authTime.getTime() / 1000),
      jti,
      exp: now + ttlSeconds,
      iat: now,
    };
    const token = await new SignJWT({ ...claims })
      .setProtectedHeader({ alg: algorithm, kid, typ: 'JWT' })
      .sign(privateKey);
    return { token, jti, claims, ttlSeconds };
  }

  async issueIdToken(input: IssueIdTokenInput): Promise<string> {
    const { kid, algorithm, privateKeyPem } = await this.signingKeyService.getActiveSigningMaterial();
    const privateKey = await importPKCS8(privateKeyPem, algorithm);
    const now = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = {
      sub: input.userId,
      tenant_id: input.tenantId,
      auth_time: Math.floor(input.authTime.getTime() / 1000),
      amr: input.amr,
    };
    if (input.nonce) {
      payload.nonce = input.nonce;
    }
    return new SignJWT(payload)
      .setProtectedHeader({ alg: algorithm, kid, typ: 'JWT' })
      .setIssuer(this.issuer)
      .setAudience(input.clientId)
      .setIssuedAt(now)
      .setExpirationTime(now + ID_TOKEN_TTL_SECONDS)
      .sign(privateKey);
  }

  /**
   * Verifies signature (against any currently-verifiable key, active or
   * inside its retirement grace window - ADR-0024), `iss`, `aud`, and `exp`.
   * Does NOT check revocation - that is `TokenRevocationService`'s job
   * (`IdentityGrpcController.ValidateToken` calls both). Throws
   * `InvalidGrantError` on any failure - callers map that to the RFC-correct
   * response for whichever surface they're on.
   */
  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    try {
      const { payload } = await jwtVerify(
        token,
        async (protectedHeader) => {
          const kid = protectedHeader.kid;
          if (!kid) {
            throw new InvalidGrantError('Access token is missing a kid header.');
          }
          const key = await this.signingKeyService.resolveVerificationKey(kid);
          if (!key) {
            throw new InvalidGrantError(`Access token was signed by an unknown or expired signing key (kid=${kid}).`);
          }
          return key;
        },
        { issuer: this.issuer, audience: this.audience },
      );
      return payload as unknown as AccessTokenClaims;
    } catch (err) {
      if (err instanceof InvalidGrantError) {
        throw err;
      }
      throw new InvalidGrantError(`Access token is invalid or expired: ${(err as Error).message}`);
    }
  }
}
