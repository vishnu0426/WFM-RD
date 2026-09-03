import { SsoLoginService, PendingSsoRequest } from '../../src/modules/sso/services/sso-login.service';

describe('SsoLoginService', () => {
  const makeRedis = () => {
    const store = new Map<string, string>();
    return {
      setWithTtl: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      del: jest.fn(async (key: string) => {
        store.delete(key);
      }),
    };
  };

  const samplePending: PendingSsoRequest = {
    tenantId: 'tenant-1',
    providerId: 'provider-1',
    clientId: 'client-1',
    redirectUri: 'http://localhost/callback',
    codeChallenge: 'challenge',
    scope: 'openid',
    originalState: 'client-state',
    nonce: 'nonce-1',
  };

  it('round-trips a pending request through create/consume', async () => {
    const redis = makeRedis();
    const service = new SsoLoginService(redis as never);

    const requestId = await service.createPendingRequest(samplePending);
    const consumed = await service.consumePendingRequest(requestId);

    expect(consumed).toEqual(samplePending);
  });

  it('is single-use: a second consume for the same request id returns null', async () => {
    const redis = makeRedis();
    const service = new SsoLoginService(redis as never);

    const requestId = await service.createPendingRequest(samplePending);
    await service.consumePendingRequest(requestId);

    await expect(service.consumePendingRequest(requestId)).resolves.toBeNull();
  });

  it('returns null for a request id that was never created', async () => {
    const redis = makeRedis();
    const service = new SsoLoginService(redis as never);
    await expect(service.consumePendingRequest('bogus')).resolves.toBeNull();
  });
});
