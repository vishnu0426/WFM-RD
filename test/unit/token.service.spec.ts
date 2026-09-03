import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { TokenService } from '../../src/modules/auth/services/token.service';
import { SigningKeyService } from '../../src/modules/auth/services/signing-key.service';
import { SigningKeyStatus } from '../../src/modules/auth/entities/signing-key-status.enum';
import { InvalidGrantError } from '../../src/modules/auth/errors/invalid-grant.error';

describe('TokenService', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const kid = randomUUID();
  const activeKey = {
    kid,
    algorithm: 'RS256',
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
    status: SigningKeyStatus.ACTIVE,
    retiredAt: null as Date | null,
  };

  const makeSigningKeyService = () =>
    new SigningKeyService({
      findActive: jest.fn().mockResolvedValue(activeKey),
      findByKid: jest.fn().mockResolvedValue(activeKey),
      findVerifiable: jest.fn().mockResolvedValue([activeKey]),
      save: jest.fn(),
      rotate: jest.fn(),
    } as never);

  const makeTokenService = () =>
    new TokenService(makeSigningKeyService(), {
      get: (key: string, fallback?: string) =>
        ({ OIDC_ISSUER: 'https://auth.agno-wfm.local', OIDC_AUDIENCE: 'agno-core-api' })[key] ?? fallback,
    } as never);

  it('issues an access token whose claims match §3.4 exactly and round-trips through verify', async () => {
    const service = makeTokenService();
    const authTime = new Date();
    const { token, jti, claims } = await service.issueAccessToken({
      userId: 'user-1',
      tenantId: 'tenant-1',
      orgUnitId: 'org-unit-1',
      roles: ['tenant_admin'],
      permissions: ['schedule:read'],
      amr: ['pwd'],
      authTime,
    });

    expect(claims).toMatchObject({
      iss: 'https://auth.agno-wfm.local',
      sub: 'user-1',
      aud: 'agno-core-api',
      tenant_id: 'tenant-1',
      org_unit_id: 'org-unit-1',
      roles: ['tenant_admin'],
      permissions: ['schedule:read'],
      amr: ['pwd'],
      jti,
    });

    const verified = await service.verifyAccessToken(token);
    expect(verified).toMatchObject({ sub: 'user-1', tenant_id: 'tenant-1', jti });
  });

  it('rejects a token signed by a different key', async () => {
    const service = makeTokenService();
    const { token } = await service.issueAccessToken({
      userId: 'user-1',
      tenantId: 'tenant-1',
      orgUnitId: null,
      roles: [],
      permissions: [],
      amr: ['pwd'],
      authTime: new Date(),
    });
    // Tamper with the payload segment so the signature no longer matches.
    const [header, , signature] = token.split('.');
    const tampered = `${header}.${Buffer.from('{"sub":"attacker"}').toString('base64url')}.${signature}`;
    await expect(service.verifyAccessToken(tampered)).rejects.toThrow(InvalidGrantError);
  });

  it('rejects an expired token', async () => {
    const service = makeTokenService();
    const { token } = await service.issueAccessToken({
      userId: 'user-1',
      tenantId: 'tenant-1',
      orgUnitId: null,
      roles: [],
      permissions: [],
      amr: ['pwd'],
      authTime: new Date(),
    });

    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    jest.setSystemTime(new Date(Date.now() + 60 * 60 * 1000)); // 1h forward, past the 12min TTL
    try {
      await expect(service.verifyAccessToken(token)).rejects.toThrow(InvalidGrantError);
    } finally {
      jest.useRealTimers();
    }
  });
});
