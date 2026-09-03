import { OfflineActionStatus } from '../../src/mobile-sync/entities/offline-action-queue.entity';
import {
  ACTION_ID,
  buildAction,
  createMobileSyncTestContext,
  EMPLOYEE_ID,
  TENANT_ID,
} from './support/mobile-sync-test-helpers';

const LOCATION = { latitude: 37.7749, longitude: -122.4194, accuracy: 5 };

describe('MobileSyncService clock_event - geofencing (ADR-0155)', () => {
  it('does not call geofenceVerification.evaluate for a non-clock_event action', async () => {
    const { repo, leaveRequestClient, geofenceVerification, service } = createMobileSyncTestContext();
    repo.findOne.mockResolvedValue(null);
    leaveRequestClient.submit.mockResolvedValue(undefined);

    await service.syncBatch(TENANT_ID, [
      buildAction({
        actionType: 'leave_request' as never,
        payload: { leaveTypeId: 'lt-1', dateRangeStart: '2026-09-01', dateRangeEnd: '2026-09-05' },
      }),
    ]);

    expect(geofenceVerification.evaluate).not.toHaveBeenCalled();
  });

  it('strips location from the persisted payload - never present in the repo.create() argument', async () => {
    const { repo, attendanceClient, service } = createMobileSyncTestContext();
    repo.findOne.mockResolvedValue(null);
    attendanceClient.forward.mockResolvedValue({ outcome: 'accepted', attendanceRecordId: 'rec-1' });

    await service.syncBatch(TENANT_ID, [buildAction({ payload: { eventType: 'clock_in', location: LOCATION } })]);

    const createArg = repo.create.mock.calls[0][0] as { payload: Record<string, unknown> };
    expect(createArg.payload).not.toHaveProperty('location');
    expect(createArg.payload).toEqual({ eventType: 'clock_in' });
  });

  it('threads the raw location into geofenceVerification.evaluate but not into attendanceClient.forward', async () => {
    const { repo, attendanceClient, geofenceVerification, service } = createMobileSyncTestContext();
    repo.findOne.mockResolvedValue(null);
    attendanceClient.forward.mockResolvedValue({ outcome: 'accepted', attendanceRecordId: 'rec-1' });
    geofenceVerification.evaluate.mockResolvedValue({ enabled: true, verified: true, enforcement: 'soft' });

    await service.syncBatch(TENANT_ID, [buildAction({ payload: { eventType: 'clock_in', location: LOCATION } })]);

    expect(geofenceVerification.evaluate).toHaveBeenCalledWith(TENANT_ID, EMPLOYEE_ID, LOCATION);
    const forwardArg = attendanceClient.forward.mock.calls[0][0];
    expect(forwardArg).not.toHaveProperty('location');
  });

  it('threads geofenceVerified=true into attendanceClient.forward and OfflineActionQueue.geofenceVerified when verified', async () => {
    const { repo, attendanceClient, geofenceVerification, service } = createMobileSyncTestContext();
    repo.findOne.mockResolvedValue(null);
    attendanceClient.forward.mockResolvedValue({ outcome: 'accepted', attendanceRecordId: 'rec-1' });
    geofenceVerification.evaluate.mockResolvedValue({ enabled: true, verified: true, enforcement: 'soft' });

    await service.syncBatch(TENANT_ID, [buildAction({ payload: { eventType: 'clock_in', location: LOCATION } })]);

    expect(attendanceClient.forward).toHaveBeenCalledWith(expect.objectContaining({ geofenceVerified: true }));
    const savedRow = repo.save.mock.calls.at(-1)?.[0] as { geofenceVerified: boolean | null };
    expect(savedRow.geofenceVerified).toBe(true);
  });

  it('soft enforcement, out-of-bounds: still forwards to attendance-leave-service, records geofenceVerified=false, status stays synced', async () => {
    const { repo, attendanceClient, geofenceVerification, service } = createMobileSyncTestContext();
    repo.findOne.mockResolvedValue(null);
    attendanceClient.forward.mockResolvedValue({ outcome: 'accepted', attendanceRecordId: 'rec-1' });
    geofenceVerification.evaluate.mockResolvedValue({ enabled: true, verified: false, enforcement: 'soft' });

    const results = await service.syncBatch(TENANT_ID, [
      buildAction({ payload: { eventType: 'clock_in', location: LOCATION } }),
    ]);

    expect(attendanceClient.forward).toHaveBeenCalledWith(expect.objectContaining({ geofenceVerified: false }));
    expect(results).toEqual([{ actionId: ACTION_ID, actionType: 'clock_event', status: 'synced' }]);
    const savedRow = repo.save.mock.calls.at(-1)?.[0] as {
      geofenceVerified: boolean | null;
      status: OfflineActionStatus;
    };
    expect(savedRow.geofenceVerified).toBe(false);
    expect(savedRow.status).toBe(OfflineActionStatus.SYNCED);
  });

  it('hard enforcement, out-of-bounds: never calls attendanceClient.forward, returns a GEOFENCE_VIOLATION conflict', async () => {
    const { repo, attendanceClient, geofenceVerification, service } = createMobileSyncTestContext();
    repo.findOne.mockResolvedValue(null);
    geofenceVerification.evaluate.mockResolvedValue({ enabled: true, verified: false, enforcement: 'hard' });

    const results = await service.syncBatch(TENANT_ID, [
      buildAction({ payload: { eventType: 'clock_in', location: LOCATION } }),
    ]);

    expect(attendanceClient.forward).not.toHaveBeenCalled();
    expect(results).toEqual([
      {
        actionId: ACTION_ID,
        actionType: 'clock_event',
        status: 'conflict',
        conflictDetails: { code: 'GEOFENCE_VIOLATION', message: expect.any(String) },
      },
    ]);
    const savedRow = repo.save.mock.calls.at(-1)?.[0] as {
      geofenceVerified: boolean | null;
      status: OfflineActionStatus;
    };
    expect(savedRow.geofenceVerified).toBe(false);
    expect(savedRow.status).toBe(OfflineActionStatus.CONFLICT);
  });

  it('hard enforcement, within bounds: forwards normally, status synced', async () => {
    const { attendanceClient, geofenceVerification, service } = createMobileSyncTestContext();
    attendanceClient.forward.mockResolvedValue({ outcome: 'accepted', attendanceRecordId: 'rec-1' });
    geofenceVerification.evaluate.mockResolvedValue({ enabled: true, verified: true, enforcement: 'hard' });

    const results = await service.syncBatch(TENANT_ID, [
      buildAction({ payload: { eventType: 'clock_in', location: LOCATION } }),
    ]);

    expect(attendanceClient.forward).toHaveBeenCalledWith(expect.objectContaining({ geofenceVerified: true }));
    expect(results).toEqual([{ actionId: ACTION_ID, actionType: 'clock_event', status: 'synced' }]);
  });

  it('declined/missing location under hard enforcement (decline-is-unverified): treated as a violation, still a conflict', async () => {
    const { attendanceClient, geofenceVerification, service } = createMobileSyncTestContext();
    // GeofenceVerificationService.evaluate itself owns the decline-is-
    // unverified rule (tested at that unit) - this test only confirms
    // mobile-sync.service.ts propagates whatever it returns.
    geofenceVerification.evaluate.mockResolvedValue({ enabled: true, verified: false, enforcement: 'hard' });

    const results = await service.syncBatch(TENANT_ID, [
      buildAction({ payload: { eventType: 'clock_in' } }), // no location field at all
    ]);

    expect(geofenceVerification.evaluate).toHaveBeenCalledWith(TENANT_ID, EMPLOYEE_ID, undefined);
    expect(attendanceClient.forward).not.toHaveBeenCalled();
    expect(results[0].status).toBe('conflict');
  });

  it('geofencing not enabled: geofenceVerified stays null, forwards normally', async () => {
    const { attendanceClient, geofenceVerification, service } = createMobileSyncTestContext();
    attendanceClient.forward.mockResolvedValue({ outcome: 'accepted', attendanceRecordId: 'rec-1' });
    geofenceVerification.evaluate.mockResolvedValue({ enabled: false, verified: null, enforcement: null });

    await service.syncBatch(TENANT_ID, [buildAction({ payload: { eventType: 'clock_in' } })]);

    expect(attendanceClient.forward).toHaveBeenCalledWith(expect.objectContaining({ geofenceVerified: null }));
  });
});
