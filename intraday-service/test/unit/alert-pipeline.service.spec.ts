import { AlertPipelineService } from '../../src/alerting/alert-pipeline.service';
import { alertRaisedTrigger } from '../../src/graphql/subscription-triggers';
import { DEFAULT_ALERT_POLICY } from '../../src/alerting/alert-policy.service';

describe('AlertPipelineService', () => {
  const makeManager = (repository: unknown) => ({
    query: jest.fn().mockResolvedValue(undefined),
    getRepository: jest.fn().mockReturnValue(repository),
  });

  const makeDataSource = (manager: unknown) => ({
    transaction: jest.fn().mockImplementation(async (cb: (m: unknown) => unknown) => cb(manager)),
  });

  const candidate = {
    tenantId: 't1',
    alertType: 'service_level_breach',
    queueId: 'q1',
    severity: 'warning' as const,
  };

  describe('raiseAlert', () => {
    it('with no prior alert, inserts a new open alert and publishes it', async () => {
      const repository = {
        findOne: jest.fn().mockResolvedValue(null),
        save: jest.fn(),
        insert: jest.fn().mockResolvedValue(undefined),
      };
      const manager = makeManager(repository);
      const policyService = {
        getPolicy: jest.fn().mockResolvedValue(DEFAULT_ALERT_POLICY),
        matchesSuppressionRule: jest.fn().mockReturnValue(false),
      };
      const pubSub = { publish: jest.fn().mockResolvedValue(undefined) };
      const service = new AlertPipelineService(
        makeDataSource(manager) as never,
        policyService as never,
        pubSub as never,
      );

      await service.raiseAlert(candidate);

      expect(repository.insert).toHaveBeenCalledTimes(1);
      const inserted = repository.insert.mock.calls[0][0];
      expect(inserted).toMatchObject({
        tenantId: 't1',
        queueId: 'q1',
        alertType: 'service_level_breach',
        status: 'open',
      });
      expect(pubSub.publish).toHaveBeenCalledWith(
        alertRaisedTrigger('t1'),
        expect.objectContaining({ alertRaised: expect.objectContaining({ status: 'open', queueId: 'q1' }) }),
      );
    });

    it('a repeat trigger within the dedup window updates lastTriggeredAt on the existing row, no new row, no publish', async () => {
      const mostRecent = {
        id: 'a1',
        status: 'open',
        createdAt: new Date('2026-08-07T09:58:00.000Z'),
        dedupGroupId: 'g1',
        acknowledgedAt: null,
      };
      const repository = {
        findOne: jest.fn().mockResolvedValue(mostRecent),
        save: jest.fn().mockResolvedValue(undefined),
        insert: jest.fn(),
      };
      const manager = makeManager(repository);
      const policyService = { getPolicy: jest.fn().mockResolvedValue(DEFAULT_ALERT_POLICY) };
      const pubSub = { publish: jest.fn() };
      const service = new AlertPipelineService(
        makeDataSource(manager) as never,
        policyService as never,
        pubSub as never,
      );

      jest.useFakeTimers().setSystemTime(new Date('2026-08-07T10:00:00.000Z'));
      await service.raiseAlert(candidate);
      jest.useRealTimers();

      expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }));
      expect(mostRecent.createdAt).not.toBeNull();
      expect(repository.insert).not.toHaveBeenCalled();
      expect(pubSub.publish).not.toHaveBeenCalled();
    });

    it('a trigger outside the dedup window that matches a suppression rule inserts a suppressed row, no publish', async () => {
      const mostRecent = {
        id: 'a1',
        status: 'resolved',
        createdAt: new Date('2026-08-07T08:00:00.000Z'),
        dedupGroupId: 'g1',
        acknowledgedAt: null,
      };
      const repository = {
        findOne: jest.fn().mockResolvedValue(mostRecent),
        save: jest.fn(),
        insert: jest.fn().mockResolvedValue(undefined),
      };
      const manager = makeManager(repository);
      const policy = {
        ...DEFAULT_ALERT_POLICY,
        suppressionRules: [{ alertType: 'service_level_breach', queueId: null, startHourUtc: 0, endHourUtc: 23 }],
      };
      const policyService = {
        getPolicy: jest.fn().mockResolvedValue(policy),
        matchesSuppressionRule: jest.fn().mockReturnValue(true),
      };
      const pubSub = { publish: jest.fn() };
      const service = new AlertPipelineService(
        makeDataSource(manager) as never,
        policyService as never,
        pubSub as never,
      );

      await service.raiseAlert(candidate);

      expect(repository.insert).toHaveBeenCalledTimes(1);
      expect(repository.insert.mock.calls[0][0]).toMatchObject({ status: 'suppressed', dedupGroupId: 'g1' });
      expect(pubSub.publish).not.toHaveBeenCalled();
    });

    it('a trigger outside the dedup window, recently acknowledged, inserts a suppressed row, no publish', async () => {
      const mostRecent = {
        id: 'a1',
        status: 'acknowledged',
        createdAt: new Date('2026-08-07T08:00:00.000Z'),
        dedupGroupId: 'g1',
        acknowledgedAt: new Date('2026-08-07T09:50:00.000Z'),
      };
      const repository = {
        findOne: jest.fn().mockResolvedValue(mostRecent),
        save: jest.fn(),
        insert: jest.fn().mockResolvedValue(undefined),
      };
      const manager = makeManager(repository);
      const policyService = {
        getPolicy: jest.fn().mockResolvedValue(DEFAULT_ALERT_POLICY),
        matchesSuppressionRule: jest.fn().mockReturnValue(false),
      };
      const pubSub = { publish: jest.fn() };
      const service = new AlertPipelineService(
        makeDataSource(manager) as never,
        policyService as never,
        pubSub as never,
      );

      jest.useFakeTimers().setSystemTime(new Date('2026-08-07T10:00:00.000Z'));
      await service.raiseAlert(candidate);
      jest.useRealTimers();

      expect(repository.insert.mock.calls[0][0]).toMatchObject({ status: 'suppressed', dedupGroupId: 'g1' });
      expect(pubSub.publish).not.toHaveBeenCalled();
    });

    it('scopes the transaction via SET LOCAL app.current_tenant_id (withTenantConnection)', async () => {
      const repository = {
        findOne: jest.fn().mockResolvedValue(null),
        save: jest.fn(),
        insert: jest.fn().mockResolvedValue(undefined),
      };
      const manager = makeManager(repository);
      const policyService = {
        getPolicy: jest.fn().mockResolvedValue(DEFAULT_ALERT_POLICY),
        matchesSuppressionRule: jest.fn().mockReturnValue(false),
      };
      const pubSub = { publish: jest.fn().mockResolvedValue(undefined) };
      const service = new AlertPipelineService(
        makeDataSource(manager) as never,
        policyService as never,
        pubSub as never,
      );

      await service.raiseAlert(candidate);

      expect(manager.query).toHaveBeenCalledWith('SELECT set_config($1, $2, true)', ['app.current_tenant_id', 't1']);
    });
  });

  describe('resolveAlert', () => {
    it('marks the most recent active alert resolved', async () => {
      const active = { id: 'a1', status: 'open', resolvedAt: null };
      const repository = { findOne: jest.fn().mockResolvedValue(active), save: jest.fn().mockResolvedValue(undefined) };
      const manager = makeManager(repository);
      const policyService = { getPolicy: jest.fn() };
      const pubSub = { publish: jest.fn() };
      const service = new AlertPipelineService(
        makeDataSource(manager) as never,
        policyService as never,
        pubSub as never,
      );

      await service.resolveAlert('t1', 'q1', 'service_level_breach');

      expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({ status: 'resolved' }));
    });

    it('is a no-op when there is no active alert', async () => {
      const repository = { findOne: jest.fn().mockResolvedValue(null), save: jest.fn() };
      const manager = makeManager(repository);
      const policyService = { getPolicy: jest.fn() };
      const pubSub = { publish: jest.fn() };
      const service = new AlertPipelineService(
        makeDataSource(manager) as never,
        policyService as never,
        pubSub as never,
      );

      await service.resolveAlert('t1', 'q1', 'service_level_breach');

      expect(repository.save).not.toHaveBeenCalled();
    });
  });
});
