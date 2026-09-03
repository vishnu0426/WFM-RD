import { ReallocationGrpcController } from '../../src/grpc/controllers/reallocation-grpc.controller';
import { ReallocationQueryService } from '../../src/reallocation/reallocation-query.service';

describe('ReallocationGrpcController.getReallocationForExplanation', () => {
  it('returns found: true with the JSON-encoded ai_rationale for an existing row', async () => {
    const queryService = {
      getById: jest.fn().mockResolvedValue({
        tenantId: 't1',
        triggeredBy: 'system_recommendation',
        fromQueueId: 'q1',
        toQueueId: 'q2',
        affectedEmployeeIds: ['e1'],
        reason: 'Queue B below target',
        status: 'approved',
        aiRationale: { triggerMetric: 'serviceLevelCurrent' },
        createdAt: new Date('2026-01-01T00:00:00Z'),
        executedAt: null,
      }),
    };
    const controller = new ReallocationGrpcController(queryService as unknown as ReallocationQueryService);

    const response = await controller.getReallocationForExplanation({
      tenantId: 't1',
      reallocationActionId: 'r1',
    });

    expect(response.found).toBe(true);
    expect(response.aiRationaleJson).toBe(JSON.stringify({ triggerMetric: 'serviceLevelCurrent' }));
    expect(response.executedAt).toBe('');
    expect(queryService.getById).toHaveBeenCalledWith('t1', 'r1');
  });

  it('returns found: false when no row matches', async () => {
    const queryService = { getById: jest.fn().mockResolvedValue(null) };
    const controller = new ReallocationGrpcController(queryService as unknown as ReallocationQueryService);

    const response = await controller.getReallocationForExplanation({
      tenantId: 't1',
      reallocationActionId: 'missing',
    });

    expect(response.found).toBe(false);
  });

  it('returns found: false for a missing tenantId/reallocationActionId without querying', async () => {
    const queryService = { getById: jest.fn() };
    const controller = new ReallocationGrpcController(queryService as unknown as ReallocationQueryService);

    const response = await controller.getReallocationForExplanation({ tenantId: '', reallocationActionId: 'r1' });

    expect(response.found).toBe(false);
    expect(queryService.getById).not.toHaveBeenCalled();
  });

  it('reports an empty ai_rationale_json (not "null") when the column is NULL', async () => {
    const queryService = {
      getById: jest.fn().mockResolvedValue({
        tenantId: 't1',
        triggeredBy: 'system_recommendation',
        fromQueueId: 'q1',
        toQueueId: 'q2',
        affectedEmployeeIds: [],
        reason: 'r',
        status: 'suggested',
        aiRationale: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        executedAt: null,
      }),
    };
    const controller = new ReallocationGrpcController(queryService as unknown as ReallocationQueryService);

    const response = await controller.getReallocationForExplanation({ tenantId: 't1', reallocationActionId: 'r1' });

    expect(response.aiRationaleJson).toBe('');
  });
});

describe('ReallocationGrpcController.listReallocationsForPeriod', () => {
  it('maps rows to summaries and passes through the disclosed total-before-cap', async () => {
    const queryService = {
      listForPeriod: jest.fn().mockResolvedValue({
        rows: [
          {
            id: 'r1',
            fromQueueId: 'q1',
            toQueueId: 'q2',
            status: 'executed',
            reason: 'r',
            createdAt: new Date('2026-01-01T00:00:00Z'),
          },
        ],
        totalMatchedBeforeCap: 150,
      }),
    };
    const controller = new ReallocationGrpcController(queryService as unknown as ReallocationQueryService);

    const response = await controller.listReallocationsForPeriod({
      tenantId: 't1',
      periodStart: '2026-01-01T00:00:00Z',
      periodEnd: '2026-01-08T00:00:00Z',
    });

    expect(response.reallocations).toHaveLength(1);
    expect(response.reallocations[0].id).toBe('r1');
    expect(response.totalMatchedBeforeCap).toBe(150);
  });

  it('returns an empty result for a missing required field, without querying', async () => {
    const queryService = { listForPeriod: jest.fn() };
    const controller = new ReallocationGrpcController(queryService as unknown as ReallocationQueryService);

    const response = await controller.listReallocationsForPeriod({ tenantId: '', periodStart: 'x', periodEnd: 'y' });

    expect(response.reallocations).toEqual([]);
    expect(queryService.listForPeriod).not.toHaveBeenCalled();
  });
});
