const mockAgentInstances: { close: jest.Mock; options: unknown }[] = [];

// GAP-12 fix: mocks `undici.Agent` rather than constructing a real one
// against fake PEM strings - this test's job is to prove the adapter wires
// the credential material into a dispatcher and closes it afterward, not
// to exercise real TLS/crypto parsing of fixture data that was never meant
// to be a valid certificate.
jest.mock('undici', () => ({
  Agent: jest.fn().mockImplementation((options: unknown) => {
    const instance = { close: jest.fn().mockResolvedValue(undefined), options };
    mockAgentInstances.push(instance);
    return instance;
  }),
}));

import { Agent } from 'undici';
import { AdpAdapter } from '../../../../../src/sync/batch/providers/adp.adapter';
import { ConnectorType, SyncJobStatus } from '../../../../../src/integrations/entities/integration-connector.entity';
import { SyncType } from '../../../../../src/integrations/entities/sync-job.entity';
import { MetricsService } from '../../../../../src/common/metrics/metrics.service';

/**
 * GAP-12/GAP-13 fixes (enterprise readiness audit, 2026-08-18): proves (a)
 * mTLS material is actually built into a dispatcher and passed to every
 * `fetch` call, and closed afterward, and (b) `fetchWorkers` now pages via
 * `$skip` instead of fetching only the first `$top` workers.
 */
describe('AdpAdapter mTLS wiring + pagination', () => {
  const connector = {
    id: 'connector-1',
    tenantId: 'tenant-1',
    provider: 'ADP',
    connectorType: ConnectorType.HRIS,
    config: { adpApiBaseUrl: 'http://fake-adp.example', credentialReference: 'secret/adp' },
  } as never;
  const job = { id: 'job-1', syncType: SyncType.INCREMENTAL } as never;

  const makeAdapter = (credential: Record<string, unknown>) => {
    const vault = { read: jest.fn().mockResolvedValue(credential) };
    const fieldMappings = { findAllForConnector: jest.fn().mockResolvedValue([]) };
    const fieldAuthorityPolicies = { findAllForConnector: jest.fn() };
    const bulkImport = { submitAndAwait: jest.fn() };
    const providerRateLimitConfig = { findByProvider: jest.fn().mockResolvedValue(null) };
    const metrics = new MetricsService();
    const adapter = new AdpAdapter(
      vault as never,
      fieldMappings as never,
      fieldAuthorityPolicies as never,
      bulkImport as never,
      providerRateLimitConfig as never,
      metrics,
    );
    return adapter;
  };

  const workerPage = (start: number, count: number) =>
    Array.from({ length: count }, (_, i) => ({ associateOID: `adp-${start + i}` }));

  beforeEach(() => {
    mockAgentInstances.length = 0;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('still fails explicitly with missing_mtls_material when Vault has no cert/key - unchanged guard', async () => {
    const adapter = makeAdapter({ accessToken: 'tok' });
    const outcome = await adapter.sync(connector, job);

    expect(outcome.status).toBe(SyncJobStatus.FAILED);
    expect((outcome.errorDetails as { reason: string }).reason).toBe('missing_mtls_material');
    expect(Agent).not.toHaveBeenCalled();
  });

  it('builds a dispatcher from the Vault cert/key, passes it on every fetch call, and closes it once the sync completes', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ workers: workerPage(0, 5) }),
    });
    global.fetch = fetchMock as never;
    const adapter = makeAdapter({ accessToken: 'tok', clientCertPem: 'CERT-MATERIAL', clientKeyPem: 'KEY-MATERIAL' });

    await adapter.sync(connector, job);

    expect(Agent).toHaveBeenCalledWith({ connect: { cert: 'CERT-MATERIAL', key: 'KEY-MATERIAL' } });
    expect(mockAgentInstances).toHaveLength(1);
    const [call] = fetchMock.mock.calls;
    expect((call[1] as { dispatcher: unknown }).dispatcher).toBe(mockAgentInstances[0]);
    expect(mockAgentInstances[0].close).toHaveBeenCalledTimes(1);
  });

  it('closes the dispatcher even when fetchWorkers throws (finally, not just the happy path)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('connection refused')) as never;
    const adapter = makeAdapter({ accessToken: 'tok', clientCertPem: 'CERT-MATERIAL', clientKeyPem: 'KEY-MATERIAL' });

    await expect(adapter.sync(connector, job)).rejects.toThrow();

    expect(mockAgentInstances).toHaveLength(1);
    expect(mockAgentInstances[0].close).toHaveBeenCalledTimes(1);
  });

  it('follows $skip across multiple pages until a short page ends the collection, accumulating every worker', async () => {
    const fetchMock = jest.fn();
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ workers: workerPage(0, 100) }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ workers: workerPage(100, 42) }),
      });
    global.fetch = fetchMock as never;
    const adapter = makeAdapter({ accessToken: 'tok', clientCertPem: 'CERT-MATERIAL', clientKeyPem: 'KEY-MATERIAL' });

    const outcome = await adapter.sync(connector, job);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls[0]).toContain('$skip=0');
    expect(urls[1]).toContain('$skip=100');
    expect((outcome.errorDetails as { totalFetched: number }).totalFetched).toBe(142);
  });
});
