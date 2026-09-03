import { MvAttritionBySiteRefreshJobService } from '../../../src/refresh/mv-attrition-by-site-refresh-job.service';
import { MetricsService } from '../../../src/common/metrics/metrics.service';

describe('MvAttritionBySiteRefreshJobService', () => {
  let replicaPool: { query: jest.Mock };
  let primaryPool: { connect: jest.Mock; query: jest.Mock };
  let client: { query: jest.Mock; release: jest.Mock };
  let service: MvAttritionBySiteRefreshJobService;

  beforeEach(() => {
    replicaPool = { query: jest.fn() };
    client = { query: jest.fn().mockResolvedValue(undefined), release: jest.fn() };
    primaryPool = { connect: jest.fn().mockResolvedValue(client), query: jest.fn() };
    service = new MvAttritionBySiteRefreshJobService(primaryPool as any, replicaPool as any, new MetricsService());
  });

  it('joins employees to their nearest site-type org_unit ancestor via the ltree <@ operator, filtering to real terminations', async () => {
    replicaPool.query.mockResolvedValueOnce({ rows: [] });

    await service.refresh();

    const sql = replicaPool.query.mock.calls[0][0];
    expect(sql).toContain("site.type = 'site'");
    expect(sql).toContain('eu.path <@ site.path');
    expect(sql).toContain('e.termination_date IS NOT NULL');
  });

  it('upserts terminations_count via the primary pool, using employees.updated_at (not termination_date) as the observation instant', async () => {
    replicaPool.query.mockResolvedValueOnce({
      rows: [
        {
          tenant_id: 't1',
          site_org_unit_id: 'site1',
          period_start: new Date('2026-08-01T00:00:00Z'),
          terminations_count: '1',
          max_observed_at: new Date('2026-08-11T09:00:00Z'),
        },
      ],
    });

    await service.refresh();

    const insertCall = client.query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO analytics_mv.mv_attrition_by_site'),
    );
    expect(insertCall?.[1]).toEqual(['t1', 'site1', expect.any(Date), '1']);
    const lineageUpdate = client.query.mock.calls.find(([sql]) => sql.includes('UPDATE analytics_mv.mv_lineage'));
    expect(lineageUpdate?.[1][0]).toEqual(new Date('2026-08-11T09:00:00Z'));
  });

  it('tick() marks mv_lineage failed via the primary pool when the source read fails', async () => {
    replicaPool.query.mockRejectedValueOnce(new Error('replica down'));

    await service.tick();

    expect(primaryPool.query).toHaveBeenCalledWith(expect.stringContaining("last_run_status = 'failed'"), [
      'mv_attrition_by_site',
    ]);
  });
});
