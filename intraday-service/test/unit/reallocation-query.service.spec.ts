import { ReallocationQueryService } from '../../src/reallocation/reallocation-query.service';

describe('ReallocationQueryService.listPendingReallocations', () => {
  it('queries suggested rows for the tenant, newest first, scoped via SET LOCAL', async () => {
    const expected = [{ id: 'r1', status: 'suggested' }];
    const repository = { find: jest.fn().mockResolvedValue(expected) };
    const manager = {
      query: jest.fn().mockResolvedValue(undefined),
      getRepository: jest.fn().mockReturnValue(repository),
    };
    const dataSource = {
      transaction: jest.fn().mockImplementation(async (cb: (m: unknown) => unknown) => cb(manager)),
    };
    const service = new ReallocationQueryService(dataSource as never);

    const result = await service.listPendingReallocations('t1');

    expect(result).toBe(expected);
    expect(repository.find).toHaveBeenCalledWith({
      where: { tenantId: 't1', status: 'suggested' },
      order: { createdAt: 'DESC' },
    });
    expect(manager.query).toHaveBeenCalledWith('SELECT set_config($1, $2, true)', ['app.current_tenant_id', 't1']);
  });
});

describe('ReallocationQueryService.getById', () => {
  it('queries a single row by id, scoped via SET LOCAL, any status', async () => {
    const expected = { id: 'r1', status: 'approved' };
    const repository = { findOne: jest.fn().mockResolvedValue(expected) };
    const manager = {
      query: jest.fn().mockResolvedValue(undefined),
      getRepository: jest.fn().mockReturnValue(repository),
    };
    const dataSource = {
      transaction: jest.fn().mockImplementation(async (cb: (m: unknown) => unknown) => cb(manager)),
    };
    const service = new ReallocationQueryService(dataSource as never);

    const result = await service.getById('t1', 'r1');

    expect(result).toBe(expected);
    expect(repository.findOne).toHaveBeenCalledWith({ where: { tenantId: 't1', id: 'r1' } });
  });

  it('returns null when no row matches', async () => {
    const repository = { findOne: jest.fn().mockResolvedValue(null) };
    const manager = {
      query: jest.fn().mockResolvedValue(undefined),
      getRepository: jest.fn().mockReturnValue(repository),
    };
    const dataSource = {
      transaction: jest.fn().mockImplementation(async (cb: (m: unknown) => unknown) => cb(manager)),
    };
    const service = new ReallocationQueryService(dataSource as never);

    expect(await service.getById('t1', 'missing')).toBeNull();
  });
});

describe('ReallocationQueryService.listForPeriod', () => {
  function buildQueryBuilder(rows: unknown[], totalCount: number) {
    const qb: Record<string, jest.Mock> = {
      where: jest.fn(),
      andWhere: jest.fn(),
      getCount: jest.fn().mockResolvedValue(totalCount),
      orderBy: jest.fn(),
      limit: jest.fn(),
      getMany: jest.fn().mockResolvedValue(rows),
    };
    qb.where.mockReturnValue(qb);
    qb.andWhere.mockReturnValue(qb);
    qb.orderBy.mockReturnValue(qb);
    qb.limit.mockReturnValue(qb);
    qb.clone = jest.fn().mockReturnValue(qb);
    return qb;
  }

  it('returns matched rows (newest-first, capped) alongside the true total before the cap', async () => {
    const rows = [{ id: 'r1' }, { id: 'r2' }];
    const qb = buildQueryBuilder(rows, 150);
    const repository = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
    const manager = {
      getRepository: jest.fn().mockReturnValue(repository),
      query: jest.fn().mockResolvedValue(undefined),
    };
    const dataSource = {
      transaction: jest.fn().mockImplementation(async (cb: (m: unknown) => unknown) => cb(manager)),
    };
    const service = new ReallocationQueryService(dataSource as never);

    const result = await service.listForPeriod('t1', new Date('2026-01-01'), new Date('2026-01-08'));

    expect(result.rows).toBe(rows);
    expect(result.totalMatchedBeforeCap).toBe(150);
    expect(qb.limit).toHaveBeenCalledWith(100);
    expect(qb.orderBy).toHaveBeenCalledWith('action.created_at', 'DESC');
  });
});
