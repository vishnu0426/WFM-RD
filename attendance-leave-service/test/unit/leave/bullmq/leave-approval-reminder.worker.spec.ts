import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import type { Job } from 'bullmq';
import { LeaveApprovalReminderWorker } from '../../../../src/leave/bullmq/leave-approval-reminder.worker';
import { LeaveRequest } from '../../../../src/leave/entities/leave-request.entity';
import { MetricsService } from '../../../../src/common/metrics/metrics.service';
import { LeaveApprovalReminderJobData } from '../../../../src/leave/bullmq/leave-approval-queue.service';

const mockWorkerOn = jest.fn();
const mockWorkerClose = jest.fn();

// Jest hoists `jest.mock` calls above imports regardless of source order,
// so `LeaveApprovalReminderWorker` above still picks up this mocked `Worker`.
jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation(() => ({
    on: mockWorkerOn,
    close: mockWorkerClose,
  })),
}));

describe('LeaveApprovalReminderWorker', () => {
  let manager: jest.Mocked<Pick<EntityManager, 'findOneBy' | 'query'>>;
  let dataSource: Pick<DataSource, 'transaction'>;
  let metrics: MetricsService;
  let worker: LeaveApprovalReminderWorker;

  function job(data: LeaveApprovalReminderJobData): Job<LeaveApprovalReminderJobData> {
    return { data } as Job<LeaveApprovalReminderJobData>;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    manager = { findOneBy: jest.fn(), query: jest.fn().mockResolvedValue(undefined) };
    dataSource = {
      transaction: jest.fn(async (work: (m: EntityManager) => Promise<unknown>) =>
        work(manager as unknown as EntityManager),
      ) as unknown as DataSource['transaction'],
    };
    metrics = new MetricsService();
    worker = new LeaveApprovalReminderWorker(dataSource as DataSource, new ConfigService({}), metrics);
  });

  it('increments the reminder-fired metric when the request is still pending', async () => {
    manager.findOneBy.mockResolvedValue({ id: 'request-1' } as LeaveRequest);
    const spy = jest.spyOn(metrics, 'recordLeaveApprovalReminderFired');

    await worker.process(job({ tenantId: 'tenant-1', leaveRequestId: 'request-1', approvalChainId: 'chain-1' }));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(manager.findOneBy).toHaveBeenCalledWith(LeaveRequest, {
      id: 'request-1',
      status: 'pending',
    });
  });

  it('no-ops (does not record the metric) when the request has already been decided', async () => {
    manager.findOneBy.mockResolvedValue(null); // status filter excludes it - already decided
    const spy = jest.spyOn(metrics, 'recordLeaveApprovalReminderFired');

    await worker.process(job({ tenantId: 'tenant-1', leaveRequestId: 'request-1', approvalChainId: 'chain-1' }));

    expect(spy).not.toHaveBeenCalled();
  });

  it('wires up a bullmq Worker on init and closes it on destroy', async () => {
    worker.onModuleInit();
    expect(mockWorkerOn).toHaveBeenCalledWith('failed', expect.any(Function));
    await worker.onModuleDestroy();
    expect(mockWorkerClose).toHaveBeenCalled();
  });
});
