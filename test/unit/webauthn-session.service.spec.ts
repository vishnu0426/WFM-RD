import { WebAuthnSessionService } from '../../src/modules/auth/services/webauthn-session.service';

describe('WebAuthnSessionService', () => {
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
      store,
    };
  };

  it('round-trips a verified session through issue/consume', async () => {
    const redis = makeRedis();
    const service = new WebAuthnSessionService(redis as never);

    const token = await service.issue({ tenantId: 'tenant-1', userId: 'user-1' });
    expect(redis.setWithTtl).toHaveBeenCalledWith(expect.stringContaining(token), expect.any(String), 300);

    const consumed = await service.consume(token);
    expect(consumed).toEqual({ tenantId: 'tenant-1', userId: 'user-1' });
  });

  it('is single-use: consuming twice returns null the second time', async () => {
    const redis = makeRedis();
    const service = new WebAuthnSessionService(redis as never);

    const token = await service.issue({ tenantId: 'tenant-1', userId: 'user-1' });
    await service.consume(token);
    const secondAttempt = await service.consume(token);

    expect(secondAttempt).toBeNull();
  });

  it('returns null for an unknown token', async () => {
    const redis = makeRedis();
    const service = new WebAuthnSessionService(redis as never);
    await expect(service.consume('never-issued')).resolves.toBeNull();
  });
});
