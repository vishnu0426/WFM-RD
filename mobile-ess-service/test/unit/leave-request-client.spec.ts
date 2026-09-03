import { LeaveRequestConflictError } from '../../src/mobile-sync/errors/leave-request-conflict.error';
import { LeaveRequestForwardFailedError } from '../../src/mobile-sync/errors/leave-request-forward-failed.error';
import { LeaveRequestClient } from '../../src/mobile-sync/providers/leave-request-client';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('LeaveRequestClient', () => {
  const request = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    employeeId: '22222222-2222-4222-8222-222222222222',
    leaveTypeId: '44444444-4444-4444-8444-444444444444',
    dateRangeStart: '2026-09-01',
    dateRangeEnd: '2026-09-05',
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends X-Tenant-Id only - no HMAC signature header, no Bearer token', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(jsonResponse(201, { id: 'lr-1', status: 'pending' }));
    const client = new LeaveRequestClient();

    await client.submit(request);

    const [, init] = fetchSpy.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers['X-Tenant-Id']).toBe(request.tenantId);
    expect(headers['x-agno-webhook-signature']).toBeUndefined();
    expect(headers.Authorization).toBeUndefined();
  });

  it('resolves on 201, regardless of conflictFlags on the created LeaveRequest (a soft annotation, never a rejection)', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      jsonResponse(201, {
        id: 'lr-1',
        status: 'approved',
        conflictFlags: { scheduleConflict: { hasConflict: true } },
      }),
    );
    const client = new LeaveRequestClient();

    await expect(client.submit(request)).resolves.toBeUndefined();
  });

  it('maps a 409 INSUFFICIENT_LEAVE_BALANCE to LeaveRequestConflictError', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        jsonResponse(409, { error: { code: 'INSUFFICIENT_LEAVE_BALANCE', message: 'Not enough balance.' } }),
      );
    const client = new LeaveRequestClient();

    await expect(client.submit(request)).rejects.toThrow(LeaveRequestConflictError);
  });

  it('maps a 503 UPSTREAM_UNAVAILABLE to LeaveRequestForwardFailedError', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        jsonResponse(503, { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'scheduling-service down.' } }),
      );
    const client = new LeaveRequestClient();

    await expect(client.submit(request)).rejects.toThrow(LeaveRequestForwardFailedError);
  });

  it('a network-level failure maps to LeaveRequestForwardFailedError', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('connection refused'));
    const client = new LeaveRequestClient();

    await expect(client.submit(request)).rejects.toThrow(LeaveRequestForwardFailedError);
  });
});
