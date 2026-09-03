import { OfflineActionStatus } from '../../src/mobile-sync/entities/offline-action-queue.entity';
import { ClockEventConflictError } from '../../src/mobile-sync/errors/clock-event-conflict.error';
import { ClockEventForwardFailedError } from '../../src/mobile-sync/errors/clock-event-forward-failed.error';
import {
  ACTION_ID,
  buildAction,
  buildRow,
  createMobileSyncTestContext,
  EMPLOYEE_ID,
  FakeUniqueViolation,
  TENANT_ID,
} from './support/mobile-sync-test-helpers';

describe('MobileSyncService - generic dispatch/idempotency behavior (via clock_event as the vehicle)', () => {
  it('processes a new clock_event action and threads createdAtDevice through unchanged to occurredAt', async () => {
    const { repo, attendanceClient, service } = createMobileSyncTestContext();
    repo.findOne.mockResolvedValue(null);
    attendanceClient.forward.mockResolvedValue({ outcome: 'accepted', attendanceRecordId: 'rec-1' });

    const results = await service.syncBatch(TENANT_ID, [buildAction()]);

    expect(results).toEqual([{ actionId: ACTION_ID, actionType: 'clock_event', status: 'synced' }]);
    expect(attendanceClient.forward).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        sourceEventId: ACTION_ID,
        employeeId: EMPLOYEE_ID,
        eventType: 'clock_in',
        occurredAt: '2026-08-14T09:00:00.000Z',
      }),
    );
  });

  it('does not reprocess a terminal (synced) row - returns the cached result without calling the upstream client again', async () => {
    const { repo, attendanceClient, service } = createMobileSyncTestContext();
    repo.findOne.mockResolvedValue(buildRow({ status: OfflineActionStatus.SYNCED }));

    const results = await service.syncBatch(TENANT_ID, [buildAction()]);

    expect(results).toEqual([{ actionId: ACTION_ID, actionType: 'clock_event', status: 'synced' }]);
    expect(attendanceClient.forward).not.toHaveBeenCalled();
  });

  it('does not reprocess a terminal (conflict) row - returns the cached conflictDetails without calling the upstream client again', async () => {
    const { repo, attendanceClient, service } = createMobileSyncTestContext();
    const conflictDetails = { code: 'ATTENDANCE_NO_OPEN_RECORD', message: 'No open clock-in.' };
    repo.findOne.mockResolvedValue(buildRow({ status: OfflineActionStatus.CONFLICT, conflictDetails }));

    const results = await service.syncBatch(TENANT_ID, [buildAction()]);

    expect(results).toEqual([{ actionId: ACTION_ID, actionType: 'clock_event', status: 'conflict', conflictDetails }]);
    expect(attendanceClient.forward).not.toHaveBeenCalled();
  });

  it('retries a failed row using its own persisted fields, not the incoming retry payload', async () => {
    const { repo, attendanceClient, service } = createMobileSyncTestContext();
    repo.findOne.mockResolvedValue(buildRow({ status: OfflineActionStatus.FAILED }));
    attendanceClient.forward.mockResolvedValue({ outcome: 'accepted', attendanceRecordId: 'rec-1' });

    // Incoming retry claims a different eventType - the stored row's own
    // payload must win, since createdAtDevice/payload are immutable once
    // queued (source spec's non-negotiable).
    const results = await service.syncBatch(TENANT_ID, [buildAction({ payload: { eventType: 'clock_out' } })]);

    expect(results).toEqual([{ actionId: ACTION_ID, actionType: 'clock_event', status: 'synced' }]);
    expect(attendanceClient.forward).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'clock_in' }));
  });

  it('maps a 409 conflict from attendance-leave-service to status: conflict with conflictDetails populated', async () => {
    const { repo, attendanceClient, service } = createMobileSyncTestContext();
    repo.findOne.mockResolvedValue(null);
    attendanceClient.forward.mockRejectedValue(
      new ClockEventConflictError('ATTENDANCE_NO_OPEN_RECORD', 'No open clock-in.'),
    );

    const results = await service.syncBatch(TENANT_ID, [buildAction({ payload: { eventType: 'clock_out' } })]);

    expect(results).toEqual([
      {
        actionId: ACTION_ID,
        actionType: 'clock_event',
        status: 'conflict',
        conflictDetails: { code: 'ATTENDANCE_NO_OPEN_RECORD', message: 'No open clock-in.' },
      },
    ]);
  });

  it('maps an upstream failure (401/503/malformed) to status: failed, retryable', async () => {
    const { repo, attendanceClient, service } = createMobileSyncTestContext();
    repo.findOne.mockResolvedValue(null);
    attendanceClient.forward.mockRejectedValue(new ClockEventForwardFailedError(503, 'unreachable'));

    const results = await service.syncBatch(TENANT_ID, [buildAction()]);

    expect(results).toEqual([
      { actionId: ACTION_ID, actionType: 'clock_event', status: 'failed', detail: 'unreachable' },
    ]);
  });

  it('handles a unique-violation race (concurrent insert of the same client-generated id) by reloading and processing the existing row', async () => {
    const { repo, attendanceClient, service } = createMobileSyncTestContext();
    repo.findOne.mockResolvedValueOnce(null); // first lookup: not found yet
    repo.findOneOrFail.mockResolvedValue(buildRow({ status: OfflineActionStatus.PENDING_SYNC })); // after unique violation, reloaded
    repo.save.mockRejectedValueOnce(new FakeUniqueViolation());
    attendanceClient.forward.mockResolvedValue({ outcome: 'accepted', attendanceRecordId: 'rec-1' });

    const results = await service.syncBatch(TENANT_ID, [buildAction()]);

    expect(results).toEqual([{ actionId: ACTION_ID, actionType: 'clock_event', status: 'synced' }]);
  });

  it('processes a batch strictly sequentially, in array order - not concurrently', async () => {
    const { repo, attendanceClient, service } = createMobileSyncTestContext();
    const callOrder: string[] = [];
    repo.findOne.mockResolvedValue(null);
    attendanceClient.forward.mockImplementation(async (request) => {
      callOrder.push(request.sourceEventId);
      // Yield a microtask so a Promise.all-based (incorrect) implementation
      // would interleave call order instead of preserving it.
      await Promise.resolve();
      return { outcome: 'accepted', attendanceRecordId: `rec-${request.sourceEventId}` };
    });

    const actionA = buildAction({ id: 'aaaaaaaa-1111-4111-8111-111111111111' });
    const actionB = buildAction({ id: 'bbbbbbbb-2222-4222-8222-222222222222', payload: { eventType: 'clock_out' } });

    await service.syncBatch(TENANT_ID, [actionA, actionB]);

    expect(callOrder).toEqual([actionA.id, actionB.id]);
  });
});
