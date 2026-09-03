import { ScheduleServiceClient } from '../../src/schedule/schedule-service-client';

describe('ScheduleServiceClient', () => {
  const makeConfig = (url = 'http://localhost:8100') => ({ get: jest.fn().mockReturnValue(url) });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('calls the employee-scoped endpoint with from/to query params and the X-Tenant-Id header', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => [{ id: 'a1' }] });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new ScheduleServiceClient(makeConfig() as never);
    const windowStart = new Date('2026-08-07T09:00:00.000Z');
    const windowEnd = new Date('2026-08-07T09:00:00.000Z');
    const result = await client.getShiftAssignments('t1', 'e1', windowStart, windowEnd);

    expect(result).toEqual([{ id: 'a1' }]);
    const [calledUrl, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(calledUrl)).toBe(
      'http://localhost:8100/v1/scheduling/employees/e1/shift-assignments?from=2026-08-07T09%3A00%3A00.000Z&to=2026-08-07T09%3A00%3A00.000Z',
    );
    expect((init.headers as Record<string, string>)['X-Tenant-Id']).toBe('t1');
  });

  it('throws when scheduling-service responds non-2xx', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch;
    const client = new ScheduleServiceClient(makeConfig() as never);

    await expect(client.getShiftAssignments('t1', 'e1', new Date(), new Date())).rejects.toThrow(/503/);
  });
});
