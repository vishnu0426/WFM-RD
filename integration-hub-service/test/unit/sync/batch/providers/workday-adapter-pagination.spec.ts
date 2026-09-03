import { WorkdayAdapter } from '../../../../../src/sync/batch/providers/workday.adapter';
import { ConnectorType, SyncJobStatus } from '../../../../../src/integrations/entities/integration-connector.entity';
import { SyncType } from '../../../../../src/integrations/entities/sync-job.entity';
import { MetricsService } from '../../../../../src/common/metrics/metrics.service';

/**
 * GAP-13 fix (enterprise readiness audit, 2026-08-18): `WorkdayAdapter.fetchWorkers`
 * used to issue exactly one GET with no `offset`/`limit` at all - proves the
 * real fix (a page loop) actually accumulates every page rather than just
 * page 1, via a mocked `fetch` (no real Postgres/Vault/root-app needed,
 * unlike `test/integration/workday-adapter.spec.ts`'s full end-to-end
 * verification of the same adapter).
 */
describe('WorkdayAdapter pagination', () => {
  const connector = {
    id: 'connector-1',
    tenantId: 'tenant-1',
    provider: 'Workday',
    connectorType: ConnectorType.HRIS,
    config: { workdayApiBaseUrl: 'http://fake-workday.example', credentialReference: 'secret/workday' },
  } as never;
  const job = { id: 'job-1', syncType: SyncType.INCREMENTAL } as never;

  const makeAdapter = () => {
    const vault = { read: jest.fn().mockResolvedValue({ accessToken: 'tok' }) };
    // No mappings at all - every fetched worker maps to `{}`, which fails
    // `isCompleteBulkImportRecord`, so `sync()` short-circuits at
    // `no_valid_records` with `totalFetched` reflecting everything
    // `fetchWorkers` actually accumulated - exactly the number this test
    // needs to prove pagination, without needing to mock the bulk-import
    // commit path at all.
    const fieldMappings = { findAllForConnector: jest.fn().mockResolvedValue([]) };
    const fieldAuthorityPolicies = { findAllForConnector: jest.fn() };
    const bulkImport = { submitAndAwait: jest.fn() };
    const providerRateLimitConfig = { findByProvider: jest.fn().mockResolvedValue(null) };
    const metrics = new MetricsService();
    const adapter = new WorkdayAdapter(
      vault as never,
      fieldMappings as never,
      fieldAuthorityPolicies as never,
      bulkImport as never,
      providerRateLimitConfig as never,
      metrics,
    );
    return { adapter, vault };
  };

  const workerPage = (start: number, count: number) =>
    Array.from({ length: count }, (_, i) => ({ workerId: `w-${start + i}` }));

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('stops after one page when the first page is short (fewer than PAGE_SIZE, no total field)', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ data: workerPage(0, 3) }),
    });
    global.fetch = fetchMock as never;
    const { adapter } = makeAdapter();

    const outcome = await adapter.sync(connector, job);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe(SyncJobStatus.FAILED);
    expect((outcome.errorDetails as { totalFetched: number }).totalFetched).toBe(3);
  });

  it('follows offset across multiple pages until a short page ends the collection, accumulating every worker', async () => {
    // PAGE_SIZE is 100 in the adapter - two full pages of 100, then a
    // short final page of 7, totalling 207.
    const fetchMock = jest.fn();
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ data: workerPage(0, 100) }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ data: workerPage(100, 100) }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ data: workerPage(200, 7) }),
      });
    global.fetch = fetchMock as never;
    const { adapter } = makeAdapter();

    const outcome = await adapter.sync(connector, job);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls[0]).toContain('offset=0');
    expect(urls[1]).toContain('offset=100');
    expect(urls[2]).toContain('offset=200');
    expect((outcome.errorDetails as { totalFetched: number }).totalFetched).toBe(207);
  });

  it('stops once offset covers a numeric total field, even on a full-sized final page', async () => {
    const fetchMock = jest.fn();
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ data: workerPage(0, 100), total: 150 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ data: workerPage(100, 50), total: 150 }),
      });
    global.fetch = fetchMock as never;
    const { adapter } = makeAdapter();

    const outcome = await adapter.sync(connector, job);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((outcome.errorDetails as { totalFetched: number }).totalFetched).toBe(150);
  });
});
