import { AdherenceExceptionQueryService } from '../../src/adherence/adherence-exception-query.service';

describe('AdherenceExceptionQueryService.list', () => {
  const makeService = (find: jest.Mock) => {
    const repository = { find };
    const manager = {
      query: jest.fn().mockResolvedValue(undefined),
      getRepository: jest.fn().mockReturnValue(repository),
    };
    const dataSource = {
      transaction: jest.fn().mockImplementation(async (cb: (m: unknown) => unknown) => cb(manager)),
    };
    return { service: new AdherenceExceptionQueryService(dataSource as never), manager };
  };

  it("queries all of the tenant's exceptions, newest-started first, when no filter is given", async () => {
    const find = jest.fn().mockResolvedValue([{ id: 'ex1' }]);
    const { service, manager } = makeService(find);

    const result = await service.list('t1', {});

    expect(result).toEqual([{ id: 'ex1' }]);
    expect(find).toHaveBeenCalledWith({ where: { tenantId: 't1' }, order: { startedAt: 'DESC' } });
    expect(manager.query).toHaveBeenCalledWith('SELECT set_config($1, $2, true)', ['app.current_tenant_id', 't1']);
  });

  it('filters by status when given', async () => {
    const find = jest.fn().mockResolvedValue([]);
    const { service } = makeService(find);

    await service.list('t1', { status: 'open' });

    expect(find).toHaveBeenCalledWith({
      where: { tenantId: 't1', status: 'open' },
      order: { startedAt: 'DESC' },
    });
  });

  it('filters by employeeId when given', async () => {
    const find = jest.fn().mockResolvedValue([]);
    const { service } = makeService(find);

    await service.list('t1', { employeeId: 'e1' });

    expect(find).toHaveBeenCalledWith({
      where: { tenantId: 't1', employeeId: 'e1' },
      order: { startedAt: 'DESC' },
    });
  });

  it('combines status and employeeId filters', async () => {
    const find = jest.fn().mockResolvedValue([]);
    const { service } = makeService(find);

    await service.list('t1', { status: 'resolved', employeeId: 'e1' });

    expect(find).toHaveBeenCalledWith({
      where: { tenantId: 't1', status: 'resolved', employeeId: 'e1' },
      order: { startedAt: 'DESC' },
    });
  });
});
