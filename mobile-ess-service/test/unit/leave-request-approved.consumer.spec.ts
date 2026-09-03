import { LeaveRequestApprovedConsumerService } from '../../src/push/consumers/leave-request-approved.consumer';

describe('LeaveRequestApprovedConsumerService.handlePayload', () => {
  const payload = {
    tenantId: 't1',
    leaveRequestId: 'lr-1',
    employeeId: 'e1',
    leaveTypeId: 'lt-1',
    dateRangeStart: '2026-09-01',
    dateRangeEnd: '2026-09-05',
    decidedAt: '2026-08-14T09:00:00.000Z',
    decidedBy: 'manager-1',
  };

  it('delegates entirely to PushDispatchService.dispatchLeaveApproved', async () => {
    const pushDispatch = { dispatchLeaveApproved: jest.fn().mockResolvedValue(undefined) };
    const consumer = new LeaveRequestApprovedConsumerService(undefined as never, pushDispatch as never);

    await consumer.handlePayload(payload);

    expect(pushDispatch.dispatchLeaveApproved).toHaveBeenCalledWith(payload);
  });

  it('propagates a PushDispatchService failure (so the base class naks for redelivery)', async () => {
    const pushDispatch = { dispatchLeaveApproved: jest.fn().mockRejectedValue(new Error('gRPC unavailable')) };
    const consumer = new LeaveRequestApprovedConsumerService(undefined as never, pushDispatch as never);

    await expect(consumer.handlePayload(payload)).rejects.toThrow('gRPC unavailable');
  });
});
