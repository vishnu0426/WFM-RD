import { AdherenceRollupService } from '../../../src/adherence/adherence-rollup.service';
import { EmployeeGrpcClientService } from '../../../src/grpc/employee-grpc-client.service';

function buildQueryBuilder(rows: unknown[]) {
  const qb: Record<string, jest.Mock> = {
    where: jest.fn(),
    andWhere: jest.fn(),
    getMany: jest.fn().mockResolvedValue(rows),
  };
  qb.where.mockReturnValue(qb);
  qb.andWhere.mockReturnValue(qb);
  return qb;
}

describe('AdherenceRollupService.getOrgUnitAdherenceSummary', () => {
  function buildService(roster: { employeeId: string }[], scoreRows: unknown[]) {
    const qb = buildQueryBuilder(scoreRows);
    const repository = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
    const manager = {
      getRepository: jest.fn().mockReturnValue(repository),
      query: jest.fn().mockResolvedValue(undefined),
    };
    const dataSource = {
      transaction: jest.fn().mockImplementation(async (cb: (m: unknown) => unknown) => cb(manager)),
    };
    const employeeGrpcClient = { getSchedulableRoster: jest.fn().mockResolvedValue(roster) };
    const service = new AdherenceRollupService(
      dataSource as never,
      employeeGrpcClient as unknown as EmployeeGrpcClientService,
    );
    return { service, employeeGrpcClient, qb };
  }

  it('aggregates adherence percentage and major deviation count across the org unit roster', async () => {
    const { service } = buildService(
      [{ employeeId: 'e1' }, { employeeId: 'e2' }],
      [
        { tenantId: 't1', employeeId: 'e1', adherencePct: '90.00', majorDeviationCount: 1 },
        { tenantId: 't1', employeeId: 'e1', adherencePct: '80.00', majorDeviationCount: 2 },
        { tenantId: 't1', employeeId: 'e2', adherencePct: '70.00', majorDeviationCount: 3 },
      ],
    );

    const result = await service.getOrgUnitAdherenceSummary(
      't1',
      'ou1',
      new Date('2026-01-01'),
      new Date('2026-01-08'),
    );

    expect(result).toEqual({
      tenantId: 't1',
      employeeCount: 2,
      scoredEmployeeCount: 2,
      periodCount: 3,
      averageAdherencePct: '80.00',
      totalMajorDeviationCount: 6,
      minAdherencePct: '70.00',
      maxAdherencePct: '90.00',
    });
  });

  it('returns null when the org unit roster is empty - never queries AdherenceScore', async () => {
    const { service, qb } = buildService([], []);

    const result = await service.getOrgUnitAdherenceSummary('t1', 'ou1', new Date(), new Date());

    expect(result).toBeNull();
    expect(qb.getMany).not.toHaveBeenCalled();
  });

  it('returns null when the roster is non-empty but no AdherenceScore rows exist in the window', async () => {
    const { service } = buildService([{ employeeId: 'e1' }], []);

    const result = await service.getOrgUnitAdherenceSummary('t1', 'ou1', new Date(), new Date());

    expect(result).toBeNull();
  });
});
