import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { exportJWK, generateKeyPair, KeyLike, SignJWT } from 'jose';
import { AccessTokenGuard, RequestWithTokenClaims } from '../../../src/auth/access-token.guard';
import { MetricsService } from '../../../src/common/metrics/metrics.service';

function fakeMetrics(): MetricsService {
  const metrics = new MetricsService();
  metrics.onModuleInit();
  return metrics;
}

const ISSUER = 'https://auth.agno-wfm.local';
const AUDIENCE = 'agno-core-api';
const KID = 'test-signing-key-1';

/** A real HTTP server serving a real JWKS - `jose.createRemoteJWKSet` does a genuine `fetch`, so this is exercised end to end rather than mocked. */
async function startJwksServer(jwk: Record<string, unknown>): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/.well-known/jwks.json` };
}

function fakeGraphQLContext(request: RequestWithTokenClaims): ExecutionContext {
  return {
    getType: () => 'graphql',
    getArgs: () => [{}, {}, { req: request }, {}],
    getClass: () => class {},
    getHandler: () => () => undefined,
  } as unknown as ExecutionContext;
}

function fakeConfig(jwksUri: string, overrides: { issuer?: string; audience?: string } = {}): ConfigService {
  const values: Record<string, string> = {
    CORE_JWKS_URI: jwksUri,
    OIDC_ISSUER: overrides.issuer ?? ISSUER,
    OIDC_AUDIENCE: overrides.audience ?? AUDIENCE,
  };
  return { get: (key: string, fallback?: string) => values[key] ?? fallback } as unknown as ConfigService;
}

describe('AccessTokenGuard', () => {
  let server: Server;
  let jwksUrl: string;
  let privateKey: KeyLike;
  let otherPrivateKey: KeyLike;

  beforeAll(async () => {
    const keyPair = await generateKeyPair('RS256');
    privateKey = keyPair.privateKey;
    const jwk = await exportJWK(keyPair.publicKey);

    // A second, never-published keypair - used to sign a token whose
    // signature the real JWKS above can never verify.
    const otherKeyPair = await generateKeyPair('RS256');
    otherPrivateKey = otherKeyPair.privateKey;

    const started = await startJwksServer({ ...jwk, kid: KID, alg: 'RS256', use: 'sig' });
    server = started.server;
    jwksUrl = started.url;
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  async function signToken(
    overrides: {
      issuer?: string;
      audience?: string;
      expiresInSeconds?: number;
      key?: KeyLike;
      kid?: string;
    } = {},
  ): Promise<string> {
    return new SignJWT({ tenant_id: 'tenant-a', permissions: ['ai_provider_config:write'], sub: 'user-1' })
      .setProtectedHeader({ alg: 'RS256', kid: overrides.kid ?? KID, typ: 'JWT' })
      .setIssuer(overrides.issuer ?? ISSUER)
      .setAudience(overrides.audience ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(overrides.expiresInSeconds ? `${overrides.expiresInSeconds}s` : '10m')
      .sign(overrides.key ?? privateKey);
  }

  it('accepts a genuine token signed by a key the real JWKS endpoint actually serves', async () => {
    const guard = new AccessTokenGuard(fakeConfig(jwksUrl), fakeMetrics());
    const token = await signToken();
    const request = { headers: { authorization: `Bearer ${token}` } } as unknown as RequestWithTokenClaims;

    const result = await guard.canActivate(fakeGraphQLContext(request));

    expect(result).toBe(true);
    expect(request.tokenClaims).toMatchObject({ tenant_id: 'tenant-a', permissions: ['ai_provider_config:write'] });
  });

  it('rejects a request with no Authorization header and records an RBAC-denial metric (Guards run before HttpMetricsInterceptor, docs/adr/0133)', async () => {
    const metrics = fakeMetrics();
    const spy = jest.spyOn(metrics, 'recordRbacDenial');
    const guard = new AccessTokenGuard(fakeConfig(jwksUrl), metrics);
    const request = { headers: {} } as unknown as RequestWithTokenClaims;

    await expect(guard.canActivate(fakeGraphQLContext(request))).rejects.toThrow(UnauthorizedException);
    expect(spy).toHaveBeenCalledWith('unauthenticated');
  });

  it('rejects a token signed by a key not present in the JWKS (never published, forged)', async () => {
    const guard = new AccessTokenGuard(fakeConfig(jwksUrl), fakeMetrics());
    const token = await signToken({ key: otherPrivateKey });
    const request = { headers: { authorization: `Bearer ${token}` } } as unknown as RequestWithTokenClaims;

    await expect(guard.canActivate(fakeGraphQLContext(request))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an expired token', async () => {
    const guard = new AccessTokenGuard(fakeConfig(jwksUrl), fakeMetrics());
    const token = await signToken({ expiresInSeconds: -60 });
    const request = { headers: { authorization: `Bearer ${token}` } } as unknown as RequestWithTokenClaims;

    await expect(guard.canActivate(fakeGraphQLContext(request))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a token with the wrong issuer (e.g. a token from a different platform deployment)', async () => {
    const guard = new AccessTokenGuard(fakeConfig(jwksUrl), fakeMetrics());
    const token = await signToken({ issuer: 'https://some-other-issuer.example' });
    const request = { headers: { authorization: `Bearer ${token}` } } as unknown as RequestWithTokenClaims;

    await expect(guard.canActivate(fakeGraphQLContext(request))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a token with the wrong audience', async () => {
    const guard = new AccessTokenGuard(fakeConfig(jwksUrl), fakeMetrics());
    const token = await signToken({ audience: 'some-other-api' });
    const request = { headers: { authorization: `Bearer ${token}` } } as unknown as RequestWithTokenClaims;

    await expect(guard.canActivate(fakeGraphQLContext(request))).rejects.toThrow(UnauthorizedException);
  });
});
