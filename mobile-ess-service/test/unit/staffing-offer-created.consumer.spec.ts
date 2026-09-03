import { StaffingOfferCreatedConsumerService } from '../../src/push/consumers/staffing-offer-created.consumer';

describe('StaffingOfferCreatedConsumerService.handlePayload', () => {
  const payload = {
    tenantId: 't1',
    staffingOfferId: 'so-1',
    queueId: 'q1',
    offerType: 'vto' as const,
    employeeId: 'e1',
    reason: 'Queue q1 is running 12.0 points over its service-level target of 0.8.',
  };

  it('delegates entirely to PushDispatchService.dispatchStaffingOfferCreated', async () => {
    const pushDispatch = { dispatchStaffingOfferCreated: jest.fn().mockResolvedValue(undefined) };
    const consumer = new StaffingOfferCreatedConsumerService(undefined as never, pushDispatch as never);

    await consumer.handlePayload(payload);

    expect(pushDispatch.dispatchStaffingOfferCreated).toHaveBeenCalledWith(payload);
  });

  it('propagates a PushDispatchService failure (so the base class naks for redelivery)', async () => {
    const pushDispatch = {
      dispatchStaffingOfferCreated: jest.fn().mockRejectedValue(new Error('gRPC unavailable')),
    };
    const consumer = new StaffingOfferCreatedConsumerService(undefined as never, pushDispatch as never);

    await expect(consumer.handlePayload(payload)).rejects.toThrow('gRPC unavailable');
  });
});
