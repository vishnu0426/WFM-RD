import { ReallocationExecutionService } from '../../src/reallocation/reallocation-execution.service';

describe('ReallocationExecutionService.applyReallocation', () => {
  it('writes the new queueId and updates queue membership for every affected employee', async () => {
    const redis = {
      writeAgentLiveState: jest.fn().mockResolvedValue(undefined),
      updateQueueMembership: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ReallocationExecutionService(redis as never);

    await service.applyReallocation('t1', 'q1', 'q2', ['e1', 'e2']);

    expect(redis.writeAgentLiveState).toHaveBeenCalledWith('t1', 'e1', { queueId: 'q2' });
    expect(redis.writeAgentLiveState).toHaveBeenCalledWith('t1', 'e2', { queueId: 'q2' });
    expect(redis.updateQueueMembership).toHaveBeenCalledWith('t1', 'e1', 'q1', 'q2');
    expect(redis.updateQueueMembership).toHaveBeenCalledWith('t1', 'e2', 'q1', 'q2');
  });

  it('is a no-op for an empty affected-employee list', async () => {
    const redis = {
      writeAgentLiveState: jest.fn().mockResolvedValue(undefined),
      updateQueueMembership: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ReallocationExecutionService(redis as never);

    await service.applyReallocation('t1', 'q1', 'q2', []);

    expect(redis.writeAgentLiveState).not.toHaveBeenCalled();
    expect(redis.updateQueueMembership).not.toHaveBeenCalled();
  });
});
