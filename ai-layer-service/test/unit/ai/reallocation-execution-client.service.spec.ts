import { ConfigService } from '@nestjs/config';
import {
  ReallocationExecutionClientService,
  ReallocationExecutionFailedError,
} from '../../../src/ai/reallocation-execution-client.service';

function makeConfig(url?: string) {
  return { get: jest.fn().mockReturnValue(url) };
}

describe('ReallocationExecutionClientService.approveReallocation', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("POSTs to the owning module's own approve endpoint with X-Tenant-Id", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = new ReallocationExecutionClientService(
      makeConfig('http://localhost:8200') as unknown as ConfigService,
    );

    await client.approveReallocation('t1', 'r1');

    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('http://localhost:8200/v1/intraday/reallocations/r1/approve');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Tenant-Id']).toBe('t1');
  });

  it('throws ReallocationExecutionFailedError when the owning module rejects the call - never silently swallowed', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 409, text: async () => 'not suggested' }) as unknown as typeof fetch;
    const client = new ReallocationExecutionClientService(
      makeConfig('http://localhost:8200') as unknown as ConfigService,
    );

    await expect(client.approveReallocation('t1', 'r1')).rejects.toThrow(ReallocationExecutionFailedError);
  });

  it('defaults to localhost:8200 when INTRADAY_REST_URL is not configured', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = new ReallocationExecutionClientService(makeConfig(undefined) as unknown as ConfigService);

    await client.approveReallocation('t1', 'r1');

    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('http://localhost:8200/v1/intraday/reallocations/r1/approve');
  });
});
