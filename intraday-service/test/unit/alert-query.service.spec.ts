import { In } from 'typeorm';
import { AlertQueryService } from '../../src/alerting/alert-query.service';

describe('AlertQueryService.listActiveAlerts', () => {
  it('queries open/acknowledged alerts for the tenant, newest first, scoped via SET LOCAL', async () => {
    const expected = [{ id: 'a1', status: 'open' }];
    const repository = { find: jest.fn().mockResolvedValue(expected) };
    const manager = {
      query: jest.fn().mockResolvedValue(undefined),
      getRepository: jest.fn().mockReturnValue(repository),
    };
    const dataSource = {
      transaction: jest.fn().mockImplementation(async (cb: (m: unknown) => unknown) => cb(manager)),
    };
    const service = new AlertQueryService(dataSource as never);

    const result = await service.listActiveAlerts('t1');

    expect(result).toBe(expected);
    expect(repository.find).toHaveBeenCalledWith({
      where: { tenantId: 't1', status: In(['open', 'acknowledged']) },
      order: { createdAt: 'DESC' },
    });
    expect(manager.query).toHaveBeenCalledWith('SELECT set_config($1, $2, true)', ['app.current_tenant_id', 't1']);
  });
});
