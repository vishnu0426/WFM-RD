import { MarketplaceHealthQueryService } from '../../../src/marketplace/marketplace-health-query.service';
import { MetricsService } from '../../../src/common/metrics/metrics.service';

describe('MarketplaceHealthQueryService (Shift Marketplace Manager View phase, §5)', () => {
  it('reads current cumulative counts straight off the metrics registry', async () => {
    const metrics = new MetricsService();
    metrics.onModuleInit();
    metrics.lockContentionTotal.inc(3);
    metrics.guardrailValidationTotal.inc({ result: 'pass' }, 10);
    metrics.guardrailValidationTotal.inc({ result: 'fail' }, 2);
    metrics.claimAttemptsTotal.inc({ result: 'rate_limited' }, 1);

    const service = new MarketplaceHealthQueryService(metrics);
    const snapshot = await service.snapshot();

    expect(snapshot.lockContentionTotal).toBe(3);
    expect(snapshot.guardrailValidationByResult).toEqual(
      expect.arrayContaining([
        { label: 'pass', count: 10 },
        { label: 'fail', count: 2 },
      ]),
    );
    expect(snapshot.claimAttemptsByResult).toEqual(expect.arrayContaining([{ label: 'rate_limited', count: 1 }]));
  });

  it('returns 0 for lockContentionTotal when nothing has been recorded yet', async () => {
    const metrics = new MetricsService();
    metrics.onModuleInit();
    const service = new MarketplaceHealthQueryService(metrics);

    const snapshot = await service.snapshot();

    expect(snapshot.lockContentionTotal).toBe(0);
    expect(snapshot.guardrailValidationByResult).toEqual([]);
  });
});
