import { SigningKeyService } from '../../src/modules/auth/services/signing-key.service';
import { SigningKeyStatus } from '../../src/modules/auth/entities/signing-key-status.enum';

describe('SigningKeyService', () => {
  const makeRepo = (overrides: Partial<Record<string, jest.Mock>> = {}) => ({
    findActive: jest.fn().mockResolvedValue(null),
    findByKid: jest.fn(),
    findVerifiable: jest.fn().mockResolvedValue([]),
    save: jest.fn().mockImplementation((k) => Promise.resolve(k)),
    rotate: jest.fn().mockImplementation((k) => Promise.resolve(k)),
    ...overrides,
  });

  it('bootstraps a new RSA signing key on module init when none is active', async () => {
    const repo = makeRepo();
    const service = new SigningKeyService(repo as never);
    await service.onModuleInit();

    expect(repo.save).toHaveBeenCalledTimes(1);
    const saved = repo.save.mock.calls[0][0];
    expect(saved.status).toBe(SigningKeyStatus.ACTIVE);
    expect(saved.algorithm).toBe('RS256');
    expect(saved.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    expect(saved.privateKeyPem).toContain('BEGIN PRIVATE KEY');
    expect(saved.kid).toEqual(expect.any(String));
  });

  it('does not bootstrap a key when one is already active', async () => {
    const repo = makeRepo({
      findActive: jest.fn().mockResolvedValue({ kid: 'existing', status: SigningKeyStatus.ACTIVE }),
    });
    const service = new SigningKeyService(repo as never);
    await service.onModuleInit();

    expect(repo.save).not.toHaveBeenCalled();
  });

  it('rotate() retires the old key and activates a new one via the repository', async () => {
    const repo = makeRepo();
    const service = new SigningKeyService(repo as never);
    await service.rotate();

    expect(repo.rotate).toHaveBeenCalledTimes(1);
    const newKey = repo.rotate.mock.calls[0][0];
    expect(newKey.status).toBe(SigningKeyStatus.ACTIVE);
  });

  it('resolveVerificationKey returns null for an unknown kid', async () => {
    const repo = makeRepo({ findByKid: jest.fn().mockResolvedValue(null) });
    const service = new SigningKeyService(repo as never);
    await expect(service.resolveVerificationKey('unknown-kid')).resolves.toBeNull();
  });

  it('resolveVerificationKey returns null for a retired key outside its grace window', async () => {
    const repo = makeRepo({
      findByKid: jest.fn().mockResolvedValue({
        kid: 'old',
        status: SigningKeyStatus.RETIRED,
        retiredAt: new Date(Date.now() - 60 * 60 * 1000), // 1h ago, grace window is 30min
        algorithm: 'RS256',
        publicKeyPem: 'irrelevant',
      }),
    });
    const service = new SigningKeyService(repo as never);
    await expect(service.resolveVerificationKey('old')).resolves.toBeNull();
  });
});
