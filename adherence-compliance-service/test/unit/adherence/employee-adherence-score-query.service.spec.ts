import { EmployeeAdherenceScoreQueryService } from '../../../src/adherence/employee-adherence-score-query.service';
import { AdherenceScorePeriodType } from '../../../src/adherence/entities/adherence-score.entity';

function buildQueryBuilder(row: unknown) {
  const qb: Record<string, jest.Mock> = {
    where: jest.fn(),
    andWhere: jest.fn(),
    getOne: jest.fn().mockResolvedValue(row),
  };
  qb.where.mockReturnValue(qb);
  qb.andWhere.mockReturnValue(qb);
  return qb;
}

describe('EmployeeAdherenceScoreQueryService.getTodayScore', () => {
  function buildService(row: unknown) {
    const qb = buildQueryBuilder(row);
    const repository = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
    const manager = {
      getRepository: jest.fn().mockReturnValue(repository),
      query: jest.fn().mockResolvedValue(undefined),
    };
    const dataSource = {
      transaction: jest.fn().mockImplementation(async (cb: (m: unknown) => unknown) => cb(manager)),
    };
    const service = new EmployeeAdherenceScoreQueryService(dataSource as never);
    return { service, qb };
  }

  it("returns the employee's day-period row when one exists covering now", async () => {
    const row = {
      tenantId: 't1',
      employeeId: 'e1',
      periodType: AdherenceScorePeriodType.DAY,
      adherencePct: '92.50',
      majorDeviationCount: 1,
    };
    const { service, qb } = buildService(row);

    const result = await service.getTodayScore('t1', 'e1');

    expect(result).toBe(row);
    expect(qb.andWhere).toHaveBeenCalledWith('score.period_type = :periodType', {
      periodType: AdherenceScorePeriodType.DAY,
    });
  });

  it('returns null when the employee has no day-period row covering now (no activity yet today)', async () => {
    const { service } = buildService(null);

    const result = await service.getTodayScore('t1', 'e1');

    expect(result).toBeNull();
  });

  it('filters by period_start <= now and period_end > now, not a fixed midnight boundary', async () => {
    const { service, qb } = buildService(null);

    await service.getTodayScore('t1', 'e1');

    const andWhereCalls = qb.andWhere.mock.calls.map((call) => call[0]);
    expect(andWhereCalls).toContain('score.period_start <= :now');
    expect(andWhereCalls).toContain('score.period_end > :now');
  });
});
