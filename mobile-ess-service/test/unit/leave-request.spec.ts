import { OfflineActionType } from '../../src/mobile-sync/entities/offline-action-queue.entity';
import { LeaveRequestConflictError } from '../../src/mobile-sync/errors/leave-request-conflict.error';
import { LeaveRequestForwardFailedError } from '../../src/mobile-sync/errors/leave-request-forward-failed.error';
import {
  ACTION_ID,
  buildAction,
  createMobileSyncTestContext,
  EMPLOYEE_ID,
  TENANT_ID,
} from './support/mobile-sync-test-helpers';

const LEAVE_PAYLOAD = {
  leaveTypeId: '44444444-4444-4444-8444-444444444444',
  dateRangeStart: '2026-09-01',
  dateRangeEnd: '2026-09-05',
};

function buildLeaveAction(overrides: Partial<Parameters<typeof buildAction>[0]> = {}) {
  return buildAction({ actionType: OfflineActionType.LEAVE_REQUEST, payload: LEAVE_PAYLOAD, ...overrides });
}

describe('MobileSyncService - leave_request', () => {
  it('processes a new leave_request and forwards the exact queued fields', async () => {
    const { repo, leaveRequestClient, service } = createMobileSyncTestContext();
    repo.findOne.mockResolvedValue(null);
    leaveRequestClient.submit.mockResolvedValue(undefined);

    const results = await service.syncBatch(TENANT_ID, [buildLeaveAction()]);

    expect(results).toEqual([{ actionId: ACTION_ID, actionType: 'leave_request', status: 'synced' }]);
    expect(leaveRequestClient.submit).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      employeeId: EMPLOYEE_ID,
      leaveTypeId: LEAVE_PAYLOAD.leaveTypeId,
      dateRangeStart: LEAVE_PAYLOAD.dateRangeStart,
      dateRangeEnd: LEAVE_PAYLOAD.dateRangeEnd,
    });
  });

  it.each([
    ['INSUFFICIENT_LEAVE_BALANCE', 'Not enough leave balance.'],
    ['LEAVE_BALANCE_NOT_FOUND', 'No leave balance configured.'],
    ['BACKDATED_LEAVE_NOT_SUPPORTED', 'dateRangeStart is now in the past.'],
    ['INVALID_LEAVE_REQUEST', 'dateRangeEnd must not be before dateRangeStart.'],
  ])('maps %s to status: conflict (this exact payload will never succeed unmodified)', async (code, message) => {
    const { repo, leaveRequestClient, service } = createMobileSyncTestContext();
    repo.findOne.mockResolvedValue(null);
    leaveRequestClient.submit.mockRejectedValue(new LeaveRequestConflictError(code, message));

    const results = await service.syncBatch(TENANT_ID, [buildLeaveAction()]);

    expect(results).toEqual([
      { actionId: ACTION_ID, actionType: 'leave_request', status: 'conflict', conflictDetails: { code, message } },
    ]);
  });

  it('maps UpstreamUnavailableError (scheduling-service down) to status: failed, retryable', async () => {
    const { repo, leaveRequestClient, service } = createMobileSyncTestContext();
    repo.findOne.mockResolvedValue(null);
    leaveRequestClient.submit.mockRejectedValue(
      new LeaveRequestForwardFailedError(503, 'scheduling-service unreachable'),
    );

    const results = await service.syncBatch(TENANT_ID, [buildLeaveAction()]);

    expect(results).toEqual([
      { actionId: ACTION_ID, actionType: 'leave_request', status: 'failed', detail: 'scheduling-service unreachable' },
    ]);
  });

  it('rejects a payload missing required fields as failed without calling the client', async () => {
    const { repo, leaveRequestClient, service } = createMobileSyncTestContext();
    repo.findOne.mockResolvedValue(null);

    const results = await service.syncBatch(TENANT_ID, [buildLeaveAction({ payload: { leaveTypeId: 'x' } })]);

    expect(results[0].status).toBe('failed');
    expect(leaveRequestClient.submit).not.toHaveBeenCalled();
  });
});
