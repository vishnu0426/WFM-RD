import { AdherenceExceptionService } from '../../src/adherence/adherence-exception.service';
import { AdherenceExceptionAlreadyResolvedError } from '../../src/common/errors/adherence-exception-already-resolved.error';
import { AdherenceExceptionNotFoundError } from '../../src/common/errors/adherence-exception-not-found.error';

describe('AdherenceExceptionService', () => {
  const makeDataSource = (manager: unknown) => ({
    transaction: jest.fn().mockImplementation(async (cb: (m: unknown) => unknown) => cb(manager)),
  });
  const makeManager = (repository: unknown) => ({
    query: jest.fn().mockResolvedValue(undefined),
    getRepository: jest.fn().mockReturnValue(repository),
  });

  describe('acknowledge', () => {
    it('sets status/acknowledgedBy/acknowledgedAt and saves', async () => {
      const exception = { id: 'ex1', tenantId: 't1', status: 'open', acknowledgedBy: null, acknowledgedAt: null };
      const repository = {
        findOne: jest.fn().mockResolvedValue(exception),
        save: jest.fn().mockResolvedValue(undefined),
      };
      const service = new AdherenceExceptionService(makeDataSource(makeManager(repository)) as never);

      const result = await service.acknowledge('t1', 'ex1', 'actor-1');

      expect(result.status).toBe('acknowledged');
      expect(result.acknowledgedBy).toBe('actor-1');
      expect(result.acknowledgedAt).toBeInstanceOf(Date);
      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'acknowledged', acknowledgedBy: 'actor-1' }),
      );
    });

    it('throws AdherenceExceptionNotFoundError when no matching row exists for the tenant', async () => {
      const repository = { findOne: jest.fn().mockResolvedValue(null), save: jest.fn() };
      const service = new AdherenceExceptionService(makeDataSource(makeManager(repository)) as never);

      await expect(service.acknowledge('t1', 'missing', 'actor-1')).rejects.toThrow(AdherenceExceptionNotFoundError);
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('throws AdherenceExceptionAlreadyResolvedError when the row is already resolved', async () => {
      const exception = { id: 'ex1', tenantId: 't1', status: 'resolved' };
      const repository = { findOne: jest.fn().mockResolvedValue(exception), save: jest.fn() };
      const service = new AdherenceExceptionService(makeDataSource(makeManager(repository)) as never);

      await expect(service.acknowledge('t1', 'ex1', 'actor-1')).rejects.toThrow(AdherenceExceptionAlreadyResolvedError);
      expect(repository.save).not.toHaveBeenCalled();
    });
  });

  describe('resolve', () => {
    it('sets status/resolutionNotes/resolvedAt and saves', async () => {
      const exception = { id: 'ex1', tenantId: 't1', status: 'open', resolutionNotes: null, resolvedAt: null };
      const repository = {
        findOne: jest.fn().mockResolvedValue(exception),
        save: jest.fn().mockResolvedValue(undefined),
      };
      const service = new AdherenceExceptionService(makeDataSource(makeManager(repository)) as never);

      const result = await service.resolve('t1', 'ex1', 'Coached the agent.');

      expect(result.status).toBe('resolved');
      expect(result.resolutionNotes).toBe('Coached the agent.');
      expect(result.resolvedAt).toBeInstanceOf(Date);
    });

    it('throws AdherenceExceptionNotFoundError when no matching row exists for the tenant', async () => {
      const repository = { findOne: jest.fn().mockResolvedValue(null), save: jest.fn() };
      const service = new AdherenceExceptionService(makeDataSource(makeManager(repository)) as never);

      await expect(service.resolve('t1', 'missing', 'notes')).rejects.toThrow(AdherenceExceptionNotFoundError);
    });

    it('throws AdherenceExceptionAlreadyResolvedError when the row is already resolved', async () => {
      const exception = { id: 'ex1', tenantId: 't1', status: 'resolved' };
      const repository = { findOne: jest.fn().mockResolvedValue(exception), save: jest.fn() };
      const service = new AdherenceExceptionService(makeDataSource(makeManager(repository)) as never);

      await expect(service.resolve('t1', 'ex1', 'notes')).rejects.toThrow(AdherenceExceptionAlreadyResolvedError);
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('allows resolving directly from open (acknowledge is not a required intermediate step)', async () => {
      const exception = { id: 'ex1', tenantId: 't1', status: 'open' };
      const repository = {
        findOne: jest.fn().mockResolvedValue(exception),
        save: jest.fn().mockResolvedValue(undefined),
      };
      const service = new AdherenceExceptionService(makeDataSource(makeManager(repository)) as never);

      const result = await service.resolve('t1', 'ex1', 'notes');

      expect(result.status).toBe('resolved');
    });
  });
});
