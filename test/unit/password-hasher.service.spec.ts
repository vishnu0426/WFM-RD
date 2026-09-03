import { PasswordHasherService } from '../../src/modules/auth/services/password-hasher.service';

describe('PasswordHasherService', () => {
  const makeService = (costFactor = 4) =>
    new PasswordHasherService({ get: jest.fn().mockReturnValue(costFactor) } as never);

  it('verifies a password against its own hash', async () => {
    const service = makeService();
    const hash = await service.hash('correct-horse-battery-staple');
    await expect(service.verify('correct-horse-battery-staple', hash)).resolves.toBe(true);
  });

  it('rejects the wrong password', async () => {
    const service = makeService();
    const hash = await service.hash('correct-horse-battery-staple');
    await expect(service.verify('wrong-password', hash)).resolves.toBe(false);
  });

  it('produces a different hash each time (random salt)', async () => {
    const service = makeService();
    const [a, b] = await Promise.all([service.hash('same-password'), service.hash('same-password')]);
    expect(a).not.toBe(b);
  });
});
