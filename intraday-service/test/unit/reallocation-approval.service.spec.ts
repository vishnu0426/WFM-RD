import { ReallocationApprovalService } from '../../src/reallocation/reallocation-approval.service';
import { ReallocationNotFoundError } from '../../src/common/errors/reallocation-not-found.error';
import { ReallocationNotSuggestedError } from '../../src/common/errors/reallocation-not-suggested.error';

describe('ReallocationApprovalService.approve', () => {
  const makeDataSource = (manager: unknown) => ({
    transaction: jest.fn().mockImplementation(async (cb: (m: unknown) => unknown) => cb(manager)),
  });

  /**
   * GAP-10 fix (enterprise readiness audit, 2026-08-18): `approve` now reads
   * the row via `createQueryBuilder(...).setLock('pessimistic_write')`
   * (a real `SELECT ... FOR UPDATE`), not `repository.findOne` - the mock
   * manager has to provide a chainable query builder matching that call
   * shape, or it validates nothing.
   */
  const makeManagerWithQueryBuilder = (row: unknown) => {
    const queryBuilder = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(row),
    };
    const repository = { save: jest.fn().mockResolvedValue(undefined) };
    const manager = {
      query: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      getRepository: jest.fn().mockReturnValue(repository),
    };
    return { manager, queryBuilder, repository };
  };

  it('approves then immediately executes a suggested row in one call - no separate execute step exists', async () => {
    const action = {
      id: 'r1',
      tenantId: 't1',
      status: 'suggested',
      fromQueueId: 'q1',
      toQueueId: 'q2',
      affectedEmployeeIds: ['e1'],
    };
    const { manager, queryBuilder, repository } = makeManagerWithQueryBuilder(action);
    const execution = { applyReallocation: jest.fn().mockResolvedValue(undefined) };
    const service = new ReallocationApprovalService(makeDataSource(manager) as never, execution as never);

    const result = await service.approve('t1', 'r1');

    expect(queryBuilder.setLock).toHaveBeenCalledWith('pessimistic_write');
    expect(execution.applyReallocation).toHaveBeenCalledWith('t1', 'q1', 'q2', ['e1']);
    expect(result.status).toBe('executed');
    expect(result.executedAt).toBeInstanceOf(Date);
    // `save` is called twice (once as 'approved', once as 'executed') on the
    // same mutable row - the mock records the object *reference*, so by the
    // time we inspect it both recorded calls already reflect the final
    // mutation. What actually proves the two-step sequence is the call
    // *order* relative to `applyReallocation` (approve -> execute -> apply
    // would be wrong; this asserts apply happens strictly between the two
    // saves).
    expect(repository.save).toHaveBeenCalledTimes(2);
    const [firstSaveOrder] = repository.save.mock.invocationCallOrder;
    const [secondSaveOrder] = repository.save.mock.invocationCallOrder.slice(1);
    const [applyOrder] = execution.applyReallocation.mock.invocationCallOrder;
    expect(firstSaveOrder).toBeLessThan(applyOrder);
    expect(applyOrder).toBeLessThan(secondSaveOrder);
  });

  it('throws ReallocationNotFoundError when no matching row exists for the tenant', async () => {
    const { manager } = makeManagerWithQueryBuilder(null);
    const execution = { applyReallocation: jest.fn() };
    const service = new ReallocationApprovalService(makeDataSource(manager) as never, execution as never);

    await expect(service.approve('t1', 'missing')).rejects.toThrow(ReallocationNotFoundError);
    expect(execution.applyReallocation).not.toHaveBeenCalled();
  });

  it('throws ReallocationNotSuggestedError when the row is already approved/rejected/executed', async () => {
    const action = { id: 'r1', tenantId: 't1', status: 'executed' };
    const { manager, repository } = makeManagerWithQueryBuilder(action);
    const execution = { applyReallocation: jest.fn() };
    const service = new ReallocationApprovalService(makeDataSource(manager) as never, execution as never);

    await expect(service.approve('t1', 'r1')).rejects.toThrow(ReallocationNotSuggestedError);
    expect(execution.applyReallocation).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('GAP-10 fix: a second call that only sees the row after the first has committed correctly rejects rather than double-executing (the row lock forces this sequencing)', async () => {
    // Simulates what the real FOR UPDATE lock guarantees: the second
    // caller's read only happens *after* the first caller's transaction
    // has fully committed the status flip to 'executed' - proving the
    // status re-check after the (mocked) lock still does its job. The lock
    // acquisition itself is Postgres's guarantee (proven separately by
    // `decide-leave-request.service.ts`'s identical, already-in-production
    // pattern in attendance-leave-service) - this test proves this
    // service's own post-lock logic reacts correctly once that ordering
    // holds.
    const suggested = {
      id: 'r1',
      tenantId: 't1',
      status: 'suggested',
      fromQueueId: 'q1',
      toQueueId: 'q2',
      affectedEmployeeIds: ['e1'],
    };
    const executed = { ...suggested, status: 'executed', executedAt: new Date() };
    const { manager: managerA } = makeManagerWithQueryBuilder(suggested);
    const { manager: managerB } = makeManagerWithQueryBuilder(executed);
    const execution = { applyReallocation: jest.fn().mockResolvedValue(undefined) };
    const serviceA = new ReallocationApprovalService(makeDataSource(managerA) as never, execution as never);
    const serviceB = new ReallocationApprovalService(makeDataSource(managerB) as never, execution as never);

    await serviceA.approve('t1', 'r1');
    await expect(serviceB.approve('t1', 'r1')).rejects.toThrow(ReallocationNotSuggestedError);
    expect(execution.applyReallocation).toHaveBeenCalledTimes(1);
  });
});
