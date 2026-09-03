import { AlertAcknowledgeService } from '../../src/alerting/alert-acknowledge.service';
import { AlertNotFoundError } from '../../src/common/errors/alert-not-found.error';

describe('AlertAcknowledgeService.acknowledge', () => {
  const makeDataSource = (manager: unknown) => ({
    transaction: jest.fn().mockImplementation(async (cb: (m: unknown) => unknown) => cb(manager)),
  });

  it('sets status/acknowledgedBy/acknowledgedAt and saves', async () => {
    const alert = { id: 'a1', tenantId: 't1', status: 'open', acknowledgedBy: null, acknowledgedAt: null };
    const repository = { findOne: jest.fn().mockResolvedValue(alert), save: jest.fn().mockResolvedValue(undefined) };
    const manager = {
      query: jest.fn().mockResolvedValue(undefined),
      getRepository: jest.fn().mockReturnValue(repository),
    };
    const service = new AlertAcknowledgeService(makeDataSource(manager) as never);

    const result = await service.acknowledge('t1', 'a1', 'actor-1');

    expect(result.status).toBe('acknowledged');
    expect(result.acknowledgedBy).toBe('actor-1');
    expect(result.acknowledgedAt).toBeInstanceOf(Date);
    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'acknowledged', acknowledgedBy: 'actor-1' }),
    );
  });

  it('throws AlertNotFoundError when no matching alert exists for the tenant', async () => {
    const repository = { findOne: jest.fn().mockResolvedValue(null), save: jest.fn() };
    const manager = {
      query: jest.fn().mockResolvedValue(undefined),
      getRepository: jest.fn().mockReturnValue(repository),
    };
    const service = new AlertAcknowledgeService(makeDataSource(manager) as never);

    await expect(service.acknowledge('t1', 'missing', 'actor-1')).rejects.toThrow(AlertNotFoundError);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('scopes the lookup to (tenantId, id), scoped via SET LOCAL', async () => {
    const alert = { id: 'a1', tenantId: 't1', status: 'open' };
    const repository = { findOne: jest.fn().mockResolvedValue(alert), save: jest.fn().mockResolvedValue(undefined) };
    const manager = {
      query: jest.fn().mockResolvedValue(undefined),
      getRepository: jest.fn().mockReturnValue(repository),
    };
    const service = new AlertAcknowledgeService(makeDataSource(manager) as never);

    await service.acknowledge('t1', 'a1', 'actor-1');

    expect(repository.findOne).toHaveBeenCalledWith({ where: { tenantId: 't1', id: 'a1' } });
    expect(manager.query).toHaveBeenCalledWith('SELECT set_config($1, $2, true)', ['app.current_tenant_id', 't1']);
  });
});
