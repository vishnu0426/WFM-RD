import { PushDispatchService } from '../../src/push/push-dispatch.service';
import { ExpoPushForwardFailedError } from '../../src/push/errors/expo-push-forward-failed.error';
import { DeviceType } from '../../src/devices/entities/device-registration.entity';
import { NotificationPreferenceGrpcClientUnavailableError } from '../../src/grpc/notification-preference-grpc-client.service';

const PAYLOAD = {
  tenantId: 't1',
  leaveRequestId: 'lr-1',
  employeeId: 'e1',
  leaveTypeId: 'lt-1',
  dateRangeStart: '2026-09-01',
  dateRangeEnd: '2026-09-05',
  decidedAt: '2026-08-14T09:00:00.000Z',
  decidedBy: 'manager-1',
};

function buildDevice(overrides: Partial<{ id: string; pushToken: string }> = {}) {
  return {
    id: 'device-1',
    tenantId: 't1',
    employeeId: 'e1',
    deviceType: DeviceType.IOS,
    pushToken: 'ExponentPushToken[abc]',
    appVersion: '1.0.0',
    biometricEnrolled: false,
    active: true,
    lastActiveAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

function buildContext(overrides?: {
  preference?: { enabled: boolean; employeeHasLinkedUser: boolean };
  devices?: ReturnType<typeof buildDevice>[];
}) {
  const devices = {
    findActiveForEmployee: jest.fn().mockResolvedValue(overrides?.devices ?? [buildDevice()]),
    markInactive: jest.fn().mockResolvedValue(undefined),
  };
  const notificationPreferenceClient = {
    isPushEnabled: jest.fn().mockResolvedValue(overrides?.preference ?? { enabled: true, employeeHasLinkedUser: true }),
  };
  const expoPushClient = { send: jest.fn().mockResolvedValue({ ok: true }) };
  const metrics = { recordPushDeliveryAttempt: jest.fn(), recordPushDeadToken: jest.fn() };
  const service = new PushDispatchService(
    devices as never,
    notificationPreferenceClient as never,
    expoPushClient as never,
    metrics as never,
  );
  return { devices, notificationPreferenceClient, expoPushClient, metrics, service };
}

describe('PushDispatchService.dispatchLeaveApproved', () => {
  it('sends via Expo when a device is registered and push is enabled', async () => {
    const { expoPushClient, metrics, service } = buildContext();

    await service.dispatchLeaveApproved(PAYLOAD);

    expect(expoPushClient.send).toHaveBeenCalledWith(
      'ExponentPushToken[abc]',
      expect.objectContaining({ title: expect.any(String), body: expect.stringContaining('2026-09-01') }),
    );
    expect(metrics.recordPushDeliveryAttempt).toHaveBeenCalledWith('sent');
  });

  it('skips with skipped_no_device when the employee has no registered devices, without calling Expo', async () => {
    const { expoPushClient, metrics, service } = buildContext({ devices: [] });

    await service.dispatchLeaveApproved(PAYLOAD);

    expect(expoPushClient.send).not.toHaveBeenCalled();
    expect(metrics.recordPushDeliveryAttempt).toHaveBeenCalledWith('skipped_no_device');
  });

  it('skips with skipped_preference_disabled when push is explicitly disabled for a linked user', async () => {
    const { devices, expoPushClient, metrics, service } = buildContext({
      preference: { enabled: false, employeeHasLinkedUser: true },
    });

    await service.dispatchLeaveApproved(PAYLOAD);

    expect(devices.findActiveForEmployee).not.toHaveBeenCalled();
    expect(expoPushClient.send).not.toHaveBeenCalled();
    expect(metrics.recordPushDeliveryAttempt).toHaveBeenCalledWith('skipped_preference_disabled');
  });

  it('skips with skipped_no_linked_user when the employee has no linked user account', async () => {
    const { metrics, service } = buildContext({ preference: { enabled: false, employeeHasLinkedUser: false } });

    await service.dispatchLeaveApproved(PAYLOAD);

    expect(metrics.recordPushDeliveryAttempt).toHaveBeenCalledWith('skipped_no_linked_user');
  });

  it('marks the device inactive and records a dead-token metric on DeviceNotRegistered', async () => {
    const { devices, expoPushClient, metrics, service } = buildContext();
    expoPushClient.send = jest.fn().mockResolvedValue({ ok: false, errorType: 'DeviceNotRegistered' });

    await service.dispatchLeaveApproved(PAYLOAD);

    expect(devices.markInactive).toHaveBeenCalledWith('t1', 'device-1');
    expect(metrics.recordPushDeadToken).toHaveBeenCalled();
    expect(metrics.recordPushDeliveryAttempt).toHaveBeenCalledWith('failed');
  });

  it('does not mark the device inactive for a non-dead-token Expo error', async () => {
    const { devices, expoPushClient, metrics, service } = buildContext();
    expoPushClient.send = jest.fn().mockResolvedValue({ ok: false, errorType: 'MessageRateExceeded' });

    await service.dispatchLeaveApproved(PAYLOAD);

    expect(devices.markInactive).not.toHaveBeenCalled();
    expect(metrics.recordPushDeliveryAttempt).toHaveBeenCalledWith('failed');
  });

  it('catches a per-device ExpoPushForwardFailedError, records failed, and does not propagate', async () => {
    const { expoPushClient, metrics, service } = buildContext();
    expoPushClient.send = jest.fn().mockRejectedValue(new ExpoPushForwardFailedError('network blip'));

    await expect(service.dispatchLeaveApproved(PAYLOAD)).resolves.toBeUndefined();
    expect(metrics.recordPushDeliveryAttempt).toHaveBeenCalledWith('failed');
  });

  it('sends independently to each of an employee’s multiple registered devices', async () => {
    const { expoPushClient, service } = buildContext({
      devices: [buildDevice({ id: 'device-1' }), buildDevice({ id: 'device-2', pushToken: 'ExponentPushToken[def]' })],
    });

    await service.dispatchLeaveApproved(PAYLOAD);

    expect(expoPushClient.send).toHaveBeenCalledTimes(2);
    expect(expoPushClient.send).toHaveBeenCalledWith('ExponentPushToken[abc]', expect.anything());
    expect(expoPushClient.send).toHaveBeenCalledWith('ExponentPushToken[def]', expect.anything());
  });

  it('propagates a gRPC preference-lookup failure (the one case that should nak for redelivery)', async () => {
    const { notificationPreferenceClient, devices, expoPushClient, service } = buildContext();
    notificationPreferenceClient.isPushEnabled = jest
      .fn()
      .mockRejectedValue(new NotificationPreferenceGrpcClientUnavailableError(new Error('UNAVAILABLE')));

    await expect(service.dispatchLeaveApproved(PAYLOAD)).rejects.toThrow(
      NotificationPreferenceGrpcClientUnavailableError,
    );
    expect(devices.findActiveForEmployee).not.toHaveBeenCalled();
    expect(expoPushClient.send).not.toHaveBeenCalled();
  });
});

const STAFFING_OFFER_PAYLOAD = {
  tenantId: 't1',
  staffingOfferId: 'so-1',
  queueId: 'q1',
  offerType: 'vto' as const,
  employeeId: 'e1',
  reason: 'Queue q1 is running 12.0 points over its service-level target of 0.8.',
};

describe('PushDispatchService.dispatchStaffingOfferCreated', () => {
  it('sends a VTO-titled push and carries the offer id/queue id/type in data', async () => {
    const { expoPushClient, service } = buildContext();

    await service.dispatchStaffingOfferCreated(STAFFING_OFFER_PAYLOAD);

    expect(expoPushClient.send).toHaveBeenCalledWith(
      'ExponentPushToken[abc]',
      expect.objectContaining({
        title: 'Voluntary time off available',
        body: STAFFING_OFFER_PAYLOAD.reason,
        data: expect.objectContaining({
          staffingOfferId: 'so-1',
          queueId: 'q1',
          offerType: 'vto',
        }),
      }),
    );
  });

  it('sends an overtime-titled push for offerType overtime', async () => {
    const { expoPushClient, service } = buildContext();

    await service.dispatchStaffingOfferCreated({ ...STAFFING_OFFER_PAYLOAD, offerType: 'overtime' });

    expect(expoPushClient.send).toHaveBeenCalledWith(
      'ExponentPushToken[abc]',
      expect.objectContaining({ title: 'Overtime available' }),
    );
  });

  it('shares the same preference/device/dead-token pipeline as dispatchLeaveApproved', async () => {
    const { metrics, service } = buildContext({ devices: [] });

    await service.dispatchStaffingOfferCreated(STAFFING_OFFER_PAYLOAD);

    expect(metrics.recordPushDeliveryAttempt).toHaveBeenCalledWith('skipped_no_device');
  });
});
