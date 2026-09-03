import { AdherenceRollupGrpcController } from '../../../src/grpc/controllers/adherence-rollup-grpc.controller';
import { AdherenceRollupService } from '../../../src/adherence/adherence-rollup.service';

describe('AdherenceRollupGrpcController.getOrgUnitAdherenceSummary', () => {
  it('returns found: true with the aggregated summary, tenantId echoed from the service result', async () => {
    const service = {
      getOrgUnitAdherenceSummary: jest.fn().mockResolvedValue({
        tenantId: 't1',
        employeeCount: 5,
        scoredEmployeeCount: 4,
        periodCount: 20,
        averageAdherencePct: '87.50',
        totalMajorDeviationCount: 3,
        minAdherencePct: '70.00',
        maxAdherencePct: '99.00',
      }),
    };
    const controller = new AdherenceRollupGrpcController(service as unknown as AdherenceRollupService);

    const response = await controller.getOrgUnitAdherenceSummary({
      tenantId: 't1',
      orgUnitId: 'ou1',
      periodStart: '2026-01-01T00:00:00Z',
      periodEnd: '2026-01-08T00:00:00Z',
    });

    expect(response.found).toBe(true);
    expect(response.tenantId).toBe('t1');
    expect(response.averageAdherencePct).toBe('87.50');
    expect(service.getOrgUnitAdherenceSummary).toHaveBeenCalledWith(
      't1',
      'ou1',
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-01-08T00:00:00Z'),
    );
  });

  it('returns found: false when the service has no data for the window', async () => {
    const service = { getOrgUnitAdherenceSummary: jest.fn().mockResolvedValue(null) };
    const controller = new AdherenceRollupGrpcController(service as unknown as AdherenceRollupService);

    const response = await controller.getOrgUnitAdherenceSummary({
      tenantId: 't1',
      orgUnitId: 'ou1',
      periodStart: '2026-01-01T00:00:00Z',
      periodEnd: '2026-01-08T00:00:00Z',
    });

    expect(response.found).toBe(false);
  });

  it('returns found: false for a missing required field, without querying', async () => {
    const service = { getOrgUnitAdherenceSummary: jest.fn() };
    const controller = new AdherenceRollupGrpcController(service as unknown as AdherenceRollupService);

    const response = await controller.getOrgUnitAdherenceSummary({
      tenantId: '',
      orgUnitId: 'ou1',
      periodStart: '2026-01-01T00:00:00Z',
      periodEnd: '2026-01-08T00:00:00Z',
    });

    expect(response.found).toBe(false);
    expect(service.getOrgUnitAdherenceSummary).not.toHaveBeenCalled();
  });
});
