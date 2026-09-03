import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { generateKeyPair, exportJWK, SignJWT, KeyLike } from 'jose';
import { AccessTokenGuard, RequestWithTokenClaims } from '../../src/auth/access-token.guard';
import { PermissionsGuard } from '../../src/auth/permissions.guard';
import { RequirePermissions } from '../../src/auth/require-permissions.decorator';
import { TenantTokenMatchGuard } from '../../src/auth/tenant-token-match.guard';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { MetricsService } from '../../src/common/metrics/metrics.service';

const ISSUER = 'https://auth.agno-wfm.local';
const AUDIENCE = 'agno-core-api';

class GatedTarget {
  @RequirePermissions('compliance_rule:write')
  gated(): void {}
  ungated(): void {}
}

function makeHttpContext(req: RequestWithTokenClaims, handler: () => void): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
  } as unknown as ExecutionContext;
}

/**
 * ADR-0161's real end-to-end verification of this module's own first RBAC
 * guard trio - own copy of integration-hub-service's/ai-layer-service's
 * identical test (their ADR-0145/ADR-0130). A real local HTTP server
 * serving a real JWKS (a freshly generated RSA keypair), real signed JWTs
 * (`jose.SignJWT`), and the actual `AccessTokenGuard`/`PermissionsGuard`/
 * `TenantTokenMatchGuard` classes `ComplianceRuleResolver`/
 * `ComplianceRuleController`/`ComplianceReportController` now use - not a
 * reimplementation or a mock of their logic.
 */
describe('RBAC guard trio (real JWKS server + real signed JWTs)', () => {
  let jwksServer: Server;
  let jwksUri: string;
  let publicKeyJwk: Record<string, unknown>;
  let privateKey: KeyLike;
  let wrongPrivateKey: KeyLike;
  let configService: ConfigService;
  let metrics: MetricsService;
  let accessTokenGuard: AccessTokenGuard;
  let permissionsGuard: PermissionsGuard;
  let tenantTokenMatchGuard: TenantTokenMatchGuard;
  let tenantContext: TenantContextService;
  const tenantId = randomUUID();

  beforeAll(async () => {
    const { publicKey, privateKey: pk } = await generateKeyPair('RS256');
    privateKey = pk;
    ({ privateKey: wrongPrivateKey } = await generateKeyPair('RS256'));
    publicKeyJwk = { ...(await exportJWK(publicKey)), kid: 'test-key-1', alg: 'RS256', use: 'sig' };

    jwksServer = createServer((req, res) => {
      if (req.url === '/.well-known/jwks.json') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ keys: [publicKeyJwk] }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
    const address = jwksServer.address();
    if (!address || typeof address === 'string') throw new Error('failed to start fake JWKS server');
    jwksUri = `http://127.0.0.1:${address.port}/.well-known/jwks.json`;

    const values: Record<string, string> = {
      CORE_JWKS_URI: jwksUri,
      OIDC_ISSUER: ISSUER,
      OIDC_AUDIENCE: AUDIENCE,
    };
    configService = { get: (key: string, def?: string) => values[key] ?? def } as unknown as ConfigService;
    metrics = new MetricsService();
    accessTokenGuard = new AccessTokenGuard(configService, metrics);
    permissionsGuard = new PermissionsGuard(new Reflector(), metrics);
    tenantContext = new TenantContextService();
    tenantTokenMatchGuard = new TenantTokenMatchGuard(tenantContext, metrics);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
  });

  async function signToken(
    key: KeyLike,
    claims: { tenant_id: string; permissions: string[] },
    overrides?: { issuer?: string; audience?: string; expiredSecondsAgo?: number },
  ): Promise<string> {
    const jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer(overrides?.issuer ?? ISSUER)
      .setAudience(overrides?.audience ?? AUDIENCE)
      .setIssuedAt();
    if (overrides?.expiredSecondsAgo) {
      jwt.setExpirationTime(Math.floor(Date.now() / 1000) - overrides.expiredSecondsAgo);
    } else {
      jwt.setExpirationTime('5m');
    }
    return jwt.sign(key);
  }

  it('a real valid token with the correct permission and matching tenant passes all three guards', async () => {
    const token = await signToken(privateKey, { tenant_id: tenantId, permissions: ['compliance_rule:write'] });
    const req: RequestWithTokenClaims = { headers: { authorization: `Bearer ${token}` } } as never;

    await expect(accessTokenGuard.canActivate(makeHttpContext(req, GatedTarget.prototype.gated))).resolves.toBe(true);
    expect(req.tokenClaims?.tenant_id).toBe(tenantId);

    expect(permissionsGuard.canActivate(makeHttpContext(req, GatedTarget.prototype.gated))).toBe(true);

    await tenantContext.run({ tenantId }, () => {
      expect(tenantTokenMatchGuard.canActivate(makeHttpContext(req, GatedTarget.prototype.gated))).toBe(true);
    });
  });

  it('rejects a request with no Authorization header', async () => {
    const req: RequestWithTokenClaims = { headers: {} } as never;
    await expect(accessTokenGuard.canActivate(makeHttpContext(req, GatedTarget.prototype.gated))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a real token signed by the wrong key', async () => {
    const token = await signToken(wrongPrivateKey, {
      tenant_id: tenantId,
      permissions: ['compliance_rule:write'],
    });
    const req: RequestWithTokenClaims = { headers: { authorization: `Bearer ${token}` } } as never;
    await expect(accessTokenGuard.canActivate(makeHttpContext(req, GatedTarget.prototype.gated))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a real expired token', async () => {
    const token = await signToken(
      privateKey,
      { tenant_id: tenantId, permissions: ['compliance_rule:write'] },
      { expiredSecondsAgo: 60 },
    );
    const req: RequestWithTokenClaims = { headers: { authorization: `Bearer ${token}` } } as never;
    await expect(accessTokenGuard.canActivate(makeHttpContext(req, GatedTarget.prototype.gated))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('PermissionsGuard rejects a valid token missing the required permission', async () => {
    const token = await signToken(privateKey, { tenant_id: tenantId, permissions: ['compliance_report:read'] });
    const req: RequestWithTokenClaims = { headers: { authorization: `Bearer ${token}` } } as never;
    await accessTokenGuard.canActivate(makeHttpContext(req, GatedTarget.prototype.gated));

    expect(() => permissionsGuard.canActivate(makeHttpContext(req, GatedTarget.prototype.gated))).toThrow(
      ForbiddenException,
    );
  });

  it('PermissionsGuard allows any token through an ungated handler (no @RequirePermissions)', async () => {
    const token = await signToken(privateKey, { tenant_id: tenantId, permissions: [] });
    const req: RequestWithTokenClaims = { headers: { authorization: `Bearer ${token}` } } as never;
    await accessTokenGuard.canActivate(makeHttpContext(req, GatedTarget.prototype.ungated));

    expect(permissionsGuard.canActivate(makeHttpContext(req, GatedTarget.prototype.ungated))).toBe(true);
  });

  it('TenantTokenMatchGuard rejects a valid token whose tenant does not match the request tenant context', async () => {
    const token = await signToken(privateKey, { tenant_id: tenantId, permissions: ['compliance_rule:write'] });
    const req: RequestWithTokenClaims = { headers: { authorization: `Bearer ${token}` } } as never;
    await accessTokenGuard.canActivate(makeHttpContext(req, GatedTarget.prototype.gated));

    const spoofedTenantId = randomUUID();
    await tenantContext.run({ tenantId: spoofedTenantId }, () => {
      expect(() => tenantTokenMatchGuard.canActivate(makeHttpContext(req, GatedTarget.prototype.gated))).toThrow(
        ForbiddenException,
      );
    });
  });
});
