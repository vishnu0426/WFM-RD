import { AlertEngineService, SERVICE_LEVEL_BREACH_ALERT_TYPE } from '../../src/alerting/alert-engine.service';

describe('AlertEngineService.evaluateQueueMetrics', () => {
  const baseRecord = {
    currentVolume: 10,
    agentsAvailable: 3,
    agentsOnCall: 2,
    forecastedVolume: 12,
    lastUpdatedAt: '2026-08-07T10:00:00.000Z',
  };

  it('raises a warning alert when the deficit is <= 20%', async () => {
    const pipeline = { raiseAlert: jest.fn().mockResolvedValue(undefined), resolveAlert: jest.fn() };
    const engine = new AlertEngineService(pipeline as never);

    await engine.evaluateQueueMetrics('t1', 'q1', { ...baseRecord, serviceLevelCurrent: 0.7, serviceLevelTarget: 0.8 });

    expect(pipeline.raiseAlert).toHaveBeenCalledWith({
      tenantId: 't1',
      alertType: SERVICE_LEVEL_BREACH_ALERT_TYPE,
      queueId: 'q1',
      severity: 'warning',
    });
  });

  it('raises a critical alert when the deficit is > 20%', async () => {
    const pipeline = { raiseAlert: jest.fn().mockResolvedValue(undefined), resolveAlert: jest.fn() };
    const engine = new AlertEngineService(pipeline as never);

    await engine.evaluateQueueMetrics('t1', 'q1', { ...baseRecord, serviceLevelCurrent: 0.5, serviceLevelTarget: 0.8 });

    expect(pipeline.raiseAlert).toHaveBeenCalledWith(expect.objectContaining({ severity: 'critical' }));
  });

  it('resolves any active alert when the queue is at or above target', async () => {
    const pipeline = { raiseAlert: jest.fn(), resolveAlert: jest.fn().mockResolvedValue(undefined) };
    const engine = new AlertEngineService(pipeline as never);

    await engine.evaluateQueueMetrics('t1', 'q1', { ...baseRecord, serviceLevelCurrent: 0.9, serviceLevelTarget: 0.8 });

    expect(pipeline.resolveAlert).toHaveBeenCalledWith('t1', 'q1', SERVICE_LEVEL_BREACH_ALERT_TYPE);
    expect(pipeline.raiseAlert).not.toHaveBeenCalled();
  });

  it('does nothing when serviceLevelCurrent or serviceLevelTarget is null (no target configured)', async () => {
    const pipeline = { raiseAlert: jest.fn(), resolveAlert: jest.fn() };
    const engine = new AlertEngineService(pipeline as never);

    await engine.evaluateQueueMetrics('t1', 'q1', {
      ...baseRecord,
      serviceLevelCurrent: null,
      serviceLevelTarget: 0.8,
    });
    await engine.evaluateQueueMetrics('t1', 'q1', {
      ...baseRecord,
      serviceLevelCurrent: 0.5,
      serviceLevelTarget: null,
    });

    expect(pipeline.raiseAlert).not.toHaveBeenCalled();
    expect(pipeline.resolveAlert).not.toHaveBeenCalled();
  });
});
