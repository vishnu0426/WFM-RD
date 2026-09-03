import { IngestionCredentialsService } from '../../src/ingestion-credentials/ingestion-credentials.service';
import { IngestionCredentialNotFoundError } from '../../src/common/errors/ingestion-credential-not-found.error';

describe('IngestionCredentialsService', () => {
  const makeDataSource = (manager: unknown) => ({
    transaction: jest.fn().mockImplementation(async (cb: (m: unknown) => unknown) => cb(manager)),
  });
  const makeManager = (repository: unknown) => ({
    query: jest.fn().mockResolvedValue(undefined),
    getRepository: jest.fn().mockReturnValue(repository),
    save: jest.fn().mockImplementation(async (_entity: unknown, row: unknown) => row),
  });

  describe('create', () => {
    it('writes the raw secret to Vault, saves a row with only the secretReference, and returns the secret exactly once', async () => {
      const manager = makeManager({});
      const vault = { write: jest.fn().mockResolvedValue(undefined) };
      const service = new IngestionCredentialsService(makeDataSource(manager) as never, vault as never);

      const result = await service.create('t1', 'Site A collector');

      expect(vault.write).toHaveBeenCalledWith(expect.stringContaining('intraday/t1/ingestion-credential/'), {
        secret: expect.any(String),
      });
      expect(result.secret).toEqual(expect.any(String));
      expect(result.credential).toMatchObject({ tenantId: 't1', label: 'Site A collector', status: 'active' });
      expect(result.credential).not.toHaveProperty('secret');
      expect(manager.save).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ secretReference: expect.stringContaining('t1') }),
      );
    });

    it('generates a different secret on every call', async () => {
      const manager = makeManager({});
      const vault = { write: jest.fn().mockResolvedValue(undefined) };
      const service = new IngestionCredentialsService(makeDataSource(manager) as never, vault as never);

      const first = await service.create('t1');
      const second = await service.create('t1');

      expect(first.secret).not.toBe(second.secret);
    });
  });

  describe('listAllForTenant', () => {
    it('queries all credentials for the tenant, newest first', async () => {
      const rows = [{ id: 'c1' }];
      const repository = { find: jest.fn().mockResolvedValue(rows) };
      const manager = makeManager(repository);
      const service = new IngestionCredentialsService(makeDataSource(manager) as never, {} as never);

      const result = await service.listAllForTenant('t1');

      expect(result).toBe(rows);
      expect(repository.find).toHaveBeenCalledWith({ where: { tenantId: 't1' }, order: { createdAt: 'DESC' } });
    });
  });

  describe('revoke', () => {
    it('sets status revoked and revokedAt, and saves', async () => {
      const credential = { id: 'c1', tenantId: 't1', status: 'active', revokedAt: null };
      const repository = {
        findOne: jest.fn().mockResolvedValue(credential),
        save: jest.fn().mockResolvedValue(undefined),
      };
      const manager = makeManager(repository);
      const service = new IngestionCredentialsService(makeDataSource(manager) as never, {} as never);

      const result = await service.revoke('t1', 'c1');

      expect(result.status).toBe('revoked');
      expect(result.revokedAt).toBeInstanceOf(Date);
      expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({ status: 'revoked' }));
    });

    it('throws IngestionCredentialNotFoundError when no matching row exists for the tenant', async () => {
      const repository = { findOne: jest.fn().mockResolvedValue(null), save: jest.fn() };
      const manager = makeManager(repository);
      const service = new IngestionCredentialsService(makeDataSource(manager) as never, {} as never);

      await expect(service.revoke('t1', 'missing')).rejects.toThrow(IngestionCredentialNotFoundError);
    });

    it('is a harmless no-op (idempotent) when the credential is already revoked', async () => {
      const credential = { id: 'c1', tenantId: 't1', status: 'revoked', revokedAt: new Date('2026-01-01') };
      const repository = { findOne: jest.fn().mockResolvedValue(credential), save: jest.fn() };
      const manager = makeManager(repository);
      const service = new IngestionCredentialsService(makeDataSource(manager) as never, {} as never);

      const result = await service.revoke('t1', 'c1');

      expect(repository.save).not.toHaveBeenCalled();
      expect(result.revokedAt).toEqual(new Date('2026-01-01'));
    });
  });

  describe('listActiveSecrets', () => {
    it("reads every active credential's secret from Vault", async () => {
      const repository = {
        find: jest.fn().mockResolvedValue([
          { id: 'c1', secretReference: 'ref-1' },
          { id: 'c2', secretReference: 'ref-2' },
        ]),
      };
      const manager = makeManager(repository);
      const vault = {
        read: jest.fn().mockImplementation(async (ref: string) => ({ secret: `secret-for-${ref}` })),
      };
      const service = new IngestionCredentialsService(makeDataSource(manager) as never, vault as never);

      const secrets = await service.listActiveSecrets('t1');

      expect(secrets).toEqual(['secret-for-ref-1', 'secret-for-ref-2']);
      expect(repository.find).toHaveBeenCalledWith({ where: { tenantId: 't1', status: 'active' } });
    });

    it('skips a credential whose Vault secret is unreadable rather than failing the whole lookup', async () => {
      const repository = {
        find: jest.fn().mockResolvedValue([
          { id: 'c1', secretReference: 'ref-1' },
          { id: 'c2', secretReference: 'ref-2' },
        ]),
      };
      const manager = makeManager(repository);
      const vault = {
        read: jest.fn().mockImplementation(async (ref: string) => {
          if (ref === 'ref-1') throw new Error('vault down');
          return { secret: 'secret-2' };
        }),
      };
      const service = new IngestionCredentialsService(makeDataSource(manager) as never, vault as never);

      const secrets = await service.listActiveSecrets('t1');

      expect(secrets).toEqual(['secret-2']);
    });

    it('returns an empty array when the tenant has no active credentials', async () => {
      const repository = { find: jest.fn().mockResolvedValue([]) };
      const manager = makeManager(repository);
      const service = new IngestionCredentialsService(makeDataSource(manager) as never, {} as never);

      await expect(service.listActiveSecrets('t1')).resolves.toEqual([]);
    });
  });
});
