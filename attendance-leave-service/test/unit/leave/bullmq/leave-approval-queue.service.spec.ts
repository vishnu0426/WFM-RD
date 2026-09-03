import { ConfigService } from '@nestjs/config';
import { LeaveApprovalQueueService } from '../../../../src/leave/bullmq/leave-approval-queue.service';

const mockAdd = jest.fn();
const mockGetJob = jest.fn();
const mockClose = jest.fn();

// Jest hoists `jest.mock` calls above imports regardless of source order,
// so `LeaveApprovalQueueService` above still picks up this mocked `Queue`.
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: mockAdd,
    getJob: mockGetJob,
    close: mockClose,
  })),
}));

describe('LeaveApprovalQueueService', () => {
  let service: LeaveApprovalQueueService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new LeaveApprovalQueueService(new ConfigService({}));
  });

  it('schedules a reminder with a deterministic jobId (leaveRequestId) and the given delay', async () => {
    await service.scheduleReminder(
      { tenantId: 'tenant-1', leaveRequestId: 'request-1', approvalChainId: 'chain-1' },
      600_000,
    );
    expect(mockAdd).toHaveBeenCalledWith(
      'reminder',
      { tenantId: 'tenant-1', leaveRequestId: 'request-1', approvalChainId: 'chain-1' },
      expect.objectContaining({ jobId: 'request-1', delay: 600_000 }),
    );
  });

  it('does not throw if scheduling fails - best-effort (ADR-0077)', async () => {
    mockAdd.mockRejectedValue(new Error('redis down'));
    await expect(
      service.scheduleReminder({ tenantId: 'tenant-1', leaveRequestId: 'request-1', approvalChainId: 'chain-1' }, 1000),
    ).resolves.toBeUndefined();
  });

  it('cancels an existing reminder job by id', async () => {
    const remove = jest.fn().mockResolvedValue(undefined);
    mockGetJob.mockResolvedValue({ remove });
    await service.cancelReminder('request-1');
    expect(mockGetJob).toHaveBeenCalledWith('request-1');
    expect(remove).toHaveBeenCalled();
  });

  it('no-ops when cancelling a job that no longer exists', async () => {
    mockGetJob.mockResolvedValue(null);
    await expect(service.cancelReminder('request-1')).resolves.toBeUndefined();
  });

  it('does not throw if cancellation fails - best-effort (ADR-0077)', async () => {
    mockGetJob.mockRejectedValue(new Error('redis down'));
    await expect(service.cancelReminder('request-1')).resolves.toBeUndefined();
  });
});
