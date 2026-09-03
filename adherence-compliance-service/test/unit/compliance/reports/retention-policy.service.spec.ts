import { RetentionPolicyService } from '../../../../src/compliance/reports/retention-policy.service';
import { RetentionPolicy } from '../../../../src/compliance/entities/retention-policy.entity';
import { InvalidRetentionYearsError } from '../../../../src/compliance/errors/invalid-retention-years.error';

describe('RetentionPolicyService', () => {
  let dataSource: { transaction: jest.Mock };
  let manager: {
    find: jest.Mock;
    findOne: jest.Mock;
    insert: jest.Mock;
    update: jest.Mock;
    findOneByOrFail: jest.Mock;
    query: jest.Mock;
  };
  let service: RetentionPolicyService;

  const tenantId = 'tenant-1';

  beforeEach(() => {
    manager = {
      find: jest.fn(),
      findOne: jest.fn(),
      insert: jest.fn(),
      update: jest.fn(),
      findOneByOrFail: jest.fn(),
      query: jest.fn().mockResolvedValue(undefined),
    };
    dataSource = { transaction: jest.fn((work: (m: unknown) => unknown) => work(manager)) };
    service = new RetentionPolicyService(dataSource as never);
  });

  describe('listPolicies', () => {
    it('returns a tenant override ahead of the platform default for the same jurisdiction, and the platform default alone for a jurisdiction with no override', async () => {
      manager.find
        .mockResolvedValueOnce([{ id: 't1', tenantId, jurisdiction: 'US-CA', retentionYears: 5 }])
        .mockResolvedValueOnce([
          { id: 'p1', tenantId: null, jurisdiction: 'US', retentionYears: 3 },
          { id: 'p2', tenantId: null, jurisdiction: 'US-CA', retentionYears: 3 },
        ]);

      const result = await service.listPolicies(tenantId);

      expect(result.map((p) => p.id)).toEqual(['p1', 't1']);
    });

    it('returns only platform defaults when the tenant has no overrides', async () => {
      manager.find
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'p1', tenantId: null, jurisdiction: 'US', retentionYears: 3 }]);

      const result = await service.listPolicies(tenantId);

      expect(result).toEqual([{ id: 'p1', tenantId: null, jurisdiction: 'US', retentionYears: 3 }]);
    });
  });

  describe('setPolicy', () => {
    it('rejects a non-positive retentionYears before ever touching the database', async () => {
      await expect(service.setPolicy(tenantId, { jurisdiction: 'US', retentionYears: 0 })).rejects.toBeInstanceOf(
        InvalidRetentionYearsError,
      );
      expect(manager.findOne).not.toHaveBeenCalled();
    });

    it('rejects a non-integer retentionYears', async () => {
      await expect(service.setPolicy(tenantId, { jurisdiction: 'US', retentionYears: 2.5 })).rejects.toBeInstanceOf(
        InvalidRetentionYearsError,
      );
    });

    it('inserts a new tenant-scoped row when no override exists yet for this jurisdiction', async () => {
      manager.findOne.mockResolvedValueOnce(null);
      manager.findOneByOrFail.mockResolvedValueOnce({ id: 'new-id' });

      await service.setPolicy(tenantId, { jurisdiction: 'US-CA', retentionYears: 5 });

      expect(manager.insert).toHaveBeenCalledWith(
        RetentionPolicy,
        expect.objectContaining({ tenantId, jurisdiction: 'US-CA', retentionYears: 5 }),
      );
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('defaults appliesToReportTypes to the full four-type list for a brand-new override', async () => {
      manager.findOne.mockResolvedValueOnce(null);
      manager.findOneByOrFail.mockResolvedValueOnce({ id: 'new-id' });

      await service.setPolicy(tenantId, { jurisdiction: 'US-CA', retentionYears: 5 });

      expect(manager.insert).toHaveBeenCalledWith(
        RetentionPolicy,
        expect.objectContaining({
          appliesToReportTypes: ['adherence_summary', 'overtime_audit', 'rest_period_audit', 'regulator_export'],
        }),
      );
    });

    it('updates the existing tenant-scoped row in place (upsert), never inserting a second one for the same jurisdiction', async () => {
      manager.findOne.mockResolvedValueOnce({
        id: 'existing-id',
        tenantId,
        jurisdiction: 'US-CA',
        retentionYears: 3,
        appliesToReportTypes: ['adherence_summary'],
      });
      manager.findOneByOrFail.mockResolvedValueOnce({ id: 'existing-id', retentionYears: 7 });

      await service.setPolicy(tenantId, { jurisdiction: 'US-CA', retentionYears: 7 });

      expect(manager.insert).not.toHaveBeenCalled();
      expect(manager.update).toHaveBeenCalledWith(
        RetentionPolicy,
        { id: 'existing-id' },
        expect.objectContaining({ retentionYears: 7, appliesToReportTypes: ['adherence_summary'] }),
      );
    });

    it('replaces appliesToReportTypes on update only when a new list is explicitly supplied', async () => {
      manager.findOne.mockResolvedValueOnce({
        id: 'existing-id',
        tenantId,
        jurisdiction: 'US-CA',
        retentionYears: 3,
        appliesToReportTypes: ['adherence_summary'],
      });
      manager.findOneByOrFail.mockResolvedValueOnce({ id: 'existing-id' });

      await service.setPolicy(tenantId, {
        jurisdiction: 'US-CA',
        retentionYears: 7,
        appliesToReportTypes: ['overtime_audit'],
      });

      expect(manager.update).toHaveBeenCalledWith(
        RetentionPolicy,
        { id: 'existing-id' },
        expect.objectContaining({ appliesToReportTypes: ['overtime_audit'] }),
      );
    });
  });
});
