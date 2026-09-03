import { PasswordAuthService } from '../../src/modules/auth/services/password-auth.service';
import { WeakPasswordError } from '../../src/modules/auth/errors/weak-password.error';

const DEFAULT_POLICY = {
  passwordMinLength: 12,
  passwordRequireUppercase: true,
  passwordRequireNumber: true,
  passwordRequireSymbol: false,
};

describe('PasswordAuthService.setPassword — tenant password policy enforcement', () => {
  let usersRepository: { findByUsername: jest.Mock; findByEmail: jest.Mock };
  let userCredentialsRepository: { findByUserId: jest.Mock; update: jest.Mock; save: jest.Mock };
  let passwordHasher: { hash: jest.Mock; verify: jest.Mock };
  let tenantSettingsRepository: { getOrCreate: jest.Mock };
  let service: PasswordAuthService;

  beforeEach(() => {
    usersRepository = { findByUsername: jest.fn(), findByEmail: jest.fn() };
    userCredentialsRepository = { findByUserId: jest.fn().mockResolvedValue(null), update: jest.fn(), save: jest.fn() };
    passwordHasher = { hash: jest.fn().mockResolvedValue('hashed'), verify: jest.fn() };
    tenantSettingsRepository = { getOrCreate: jest.fn().mockResolvedValue({ ...DEFAULT_POLICY }) };
    service = new PasswordAuthService(
      usersRepository as never,
      userCredentialsRepository as never,
      passwordHasher as never,
      tenantSettingsRepository as never,
    );
  });

  it('rejects a password below the tenant’s configured minimum length', async () => {
    await expect(service.setPassword('u1', 't1', 'Short1')).rejects.toThrow(WeakPasswordError);
    expect(userCredentialsRepository.save).not.toHaveBeenCalled();
  });

  it('rejects a password missing a required uppercase letter, naming the specific rule', async () => {
    await expect(service.setPassword('u1', 't1', 'alllowercase123')).rejects.toMatchObject({
      details: { unmetRules: expect.arrayContaining([expect.stringContaining('uppercase')]) },
    });
  });

  it('rejects a password missing a required number', async () => {
    await expect(service.setPassword('u1', 't1', 'NoNumbersHere')).rejects.toMatchObject({
      details: { unmetRules: expect.arrayContaining([expect.stringContaining('number')]) },
    });
  });

  it('accepts a password that satisfies the default policy', async () => {
    await expect(service.setPassword('u1', 't1', 'ValidPassw0rd')).resolves.toBeUndefined();
    expect(userCredentialsRepository.save).toHaveBeenCalled();
  });

  it('a stricter per-tenant policy (symbol required) rejects a password a default-policy tenant would accept', async () => {
    tenantSettingsRepository.getOrCreate.mockResolvedValue({ ...DEFAULT_POLICY, passwordRequireSymbol: true });
    await expect(service.setPassword('u1', 't1', 'ValidPassw0rd')).rejects.toMatchObject({
      details: { unmetRules: expect.arrayContaining([expect.stringContaining('symbol')]) },
    });
  });

  it('a looser per-tenant policy (no uppercase required) accepts a password the default policy would reject', async () => {
    tenantSettingsRepository.getOrCreate.mockResolvedValue({ ...DEFAULT_POLICY, passwordRequireUppercase: false });
    await expect(service.setPassword('u1', 't1', 'alllowercase123')).resolves.toBeUndefined();
  });
});
