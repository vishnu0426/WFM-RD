import { ActivityChangeResolver } from '../../src/graphql/resolvers/activity-change.resolver';

describe('ActivityChangeResolver.reportActivityChange', () => {
  it('builds a manual:-prefixed sourceEventId and delegates to IngestionService.ingest', async () => {
    const ingestion = { ingest: jest.fn().mockResolvedValue('accepted') };
    const tenantContext = { requireTenantId: jest.fn().mockReturnValue('t1') };
    const resolver = new ActivityChangeResolver(ingestion as never, tenantContext as never);

    const result = await resolver.reportActivityChange({
      employeeId: 'e1',
      currentActivity: 'on_call',
      activityStartedAt: new Date('2026-08-07T10:00:00.000Z'),
      siteId: 's1',
      queueId: 'q1',
    });

    expect(result.status).toBe('accepted');
    expect(result.sourceEventId).toMatch(/^manual:/);
    expect(ingestion.ingest).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({
        employeeId: 'e1',
        currentActivity: 'on_call',
        activityStartedAt: '2026-08-07T10:00:00.000Z',
        siteId: 's1',
        queueId: 'q1',
        sourceEventId: result.sourceEventId,
      }),
    );
  });

  it('generates a distinct sourceEventId on every call (never reuses one across manual reports)', async () => {
    const ingestion = { ingest: jest.fn().mockResolvedValue('accepted') };
    const tenantContext = { requireTenantId: jest.fn().mockReturnValue('t1') };
    const resolver = new ActivityChangeResolver(ingestion as never, tenantContext as never);
    const input = {
      employeeId: 'e1',
      currentActivity: 'on_call',
      activityStartedAt: new Date('2026-08-07T10:00:00.000Z'),
    };

    const first = await resolver.reportActivityChange(input);
    const second = await resolver.reportActivityChange(input);

    expect(first.sourceEventId).not.toBe(second.sourceEventId);
  });

  it('returns "duplicate" when IngestionService dedupes the event', async () => {
    const ingestion = { ingest: jest.fn().mockResolvedValue('duplicate') };
    const tenantContext = { requireTenantId: jest.fn().mockReturnValue('t1') };
    const resolver = new ActivityChangeResolver(ingestion as never, tenantContext as never);

    const result = await resolver.reportActivityChange({
      employeeId: 'e1',
      currentActivity: 'on_call',
      activityStartedAt: new Date('2026-08-07T10:00:00.000Z'),
    });

    expect(result.status).toBe('duplicate');
  });
});
