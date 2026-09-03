import { DashboardService } from '../../../src/analytics/dashboard.service';
import { SavedReport, SavedReportType } from '../../../src/analytics/entities/saved-report.entity';
import { DashboardWidget } from '../../../src/analytics/entities/dashboard-widget.entity';
import { MetricCostTier } from '../../../src/analytics/entities/metric-definition.entity';
import { DashboardNotFoundError } from '../../../src/analytics/errors/dashboard-not-found.error';
import { MetricNotFoundError } from '../../../src/analytics/errors/metric-not-found.error';
import { ExpensiveMetricNotAllowedOnWidgetError } from '../../../src/analytics/errors/expensive-metric-not-allowed-on-widget.error';
import { UnvalidatedMetricNotAllowedOnWidgetError } from '../../../src/analytics/errors/metric-validation-failed.error';

describe('DashboardService', () => {
  let dataSource: { transaction: jest.Mock };
  let manager: {
    findOne: jest.Mock;
    find: jest.Mock;
    insert: jest.Mock;
    findOneByOrFail: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    query: jest.Mock;
  };
  let service: DashboardService;

  const tenantId = 'tenant-1';
  const actorId = 'actor-1';

  beforeEach(() => {
    manager = {
      findOne: jest.fn(),
      find: jest.fn(),
      insert: jest.fn(),
      findOneByOrFail: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      query: jest.fn().mockResolvedValue(undefined),
    };
    dataSource = { transaction: jest.fn((work: (m: unknown) => unknown) => work(manager)) };
    service = new DashboardService(dataSource as any);
  });

  describe('createDashboard', () => {
    const cheapMetric = {
      id: 'metric-1',
      name: 'adherence_trend',
      estimatedCostTier: MetricCostTier.CHEAP,
      validatedAt: new Date('2026-08-01T00:00:00Z'),
    };

    it('throws UnvalidatedMetricNotAllowedOnWidgetError for a metric that has never been validated (Phase 5, ADR-0110)', async () => {
      manager.findOne.mockResolvedValueOnce({ ...cheapMetric, validatedAt: null });

      await expect(
        service.createDashboard(tenantId, actorId, {
          name: 'D1',
          config: {},
          widgets: [{ widgetType: 'kpi_tile', metricId: 'metric-1', position: {} }],
        }),
      ).rejects.toThrow(UnvalidatedMetricNotAllowedOnWidgetError);
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it('throws MetricNotFoundError when a widget references a metric visible to neither this tenant nor the platform', async () => {
      manager.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

      await expect(
        service.createDashboard(tenantId, actorId, {
          name: 'D1',
          config: {},
          widgets: [{ widgetType: 'kpi_tile', metricId: 'missing', position: {} }],
        }),
      ).rejects.toThrow(MetricNotFoundError);
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it('throws ExpensiveMetricNotAllowedOnWidgetError for a metric tiered expensive', async () => {
      manager.findOne.mockResolvedValueOnce({ ...cheapMetric, estimatedCostTier: MetricCostTier.EXPENSIVE });

      await expect(
        service.createDashboard(tenantId, actorId, {
          name: 'D1',
          config: {},
          widgets: [{ widgetType: 'kpi_tile', metricId: 'metric-1', position: {} }],
        }),
      ).rejects.toThrow(ExpensiveMetricNotAllowedOnWidgetError);
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it('inserts the SavedReport and every widget, then returns them', async () => {
      manager.findOne.mockResolvedValueOnce(cheapMetric);
      manager.findOneByOrFail
        .mockResolvedValueOnce({
          id: 'widget-1',
          dashboardId: 'dash-1',
          widgetType: 'kpi_tile',
          metricId: 'metric-1',
          position: {},
        })
        .mockResolvedValueOnce({ id: 'dash-1', name: 'D1', reportType: SavedReportType.DASHBOARD, createdBy: actorId });

      const result = await service.createDashboard(tenantId, actorId, {
        name: 'D1',
        config: { theme: 'dark' },
        widgets: [{ widgetType: 'kpi_tile', metricId: 'metric-1', position: { x: 0 } }],
      });

      expect(manager.insert).toHaveBeenCalledWith(
        SavedReport,
        expect.objectContaining({
          createdBy: actorId,
          name: 'D1',
          reportType: SavedReportType.DASHBOARD,
          sharedWith: [],
        }),
      );
      expect(manager.insert).toHaveBeenCalledWith(
        DashboardWidget,
        expect.objectContaining({ widgetType: 'kpi_tile', metricId: 'metric-1' }),
      );
      expect(result.widgets).toHaveLength(1);
      expect(result.dashboard.name).toBe('D1');
    });

    it('checks a tenant-specific metric override before falling back to the platform default', async () => {
      manager.findOne.mockResolvedValueOnce(cheapMetric); // tenant-specific hit, no fallback call
      manager.findOneByOrFail.mockResolvedValue({ id: 'x' });

      await service.createDashboard(tenantId, actorId, {
        name: 'D1',
        config: {},
        widgets: [{ widgetType: 'kpi_tile', metricId: 'metric-1', position: {} }],
      });

      expect(manager.findOne).toHaveBeenCalledTimes(1);
    });

    it('ADR-0163: stores sharedWithRoles verbatim on the sharedWith column when supplied', async () => {
      manager.findOne.mockResolvedValueOnce(cheapMetric);
      manager.findOneByOrFail.mockResolvedValue({ id: 'x' });

      await service.createDashboard(tenantId, actorId, {
        name: 'D1',
        config: {},
        widgets: [{ widgetType: 'kpi_tile', metricId: 'metric-1', position: {} }],
        sharedWithRoles: ['manager', 'analyst'],
      });

      expect(manager.insert).toHaveBeenCalledWith(
        SavedReport,
        expect.objectContaining({ sharedWith: ['manager', 'analyst'] }),
      );
    });
  });

  describe('getDashboard', () => {
    it('throws DashboardNotFoundError when no row matches', async () => {
      manager.findOne.mockResolvedValueOnce(null);

      await expect(service.getDashboard(tenantId, actorId, [], 'dash-1')).rejects.toThrow(DashboardNotFoundError);
    });

    it('throws DashboardNotFoundError when the row was created by a different actor and not shared with any role the caller holds', async () => {
      manager.findOne.mockResolvedValueOnce({ id: 'dash-1', createdBy: 'someone-else', sharedWith: ['manager'] });

      await expect(service.getDashboard(tenantId, actorId, ['analyst'], 'dash-1')).rejects.toThrow(
        DashboardNotFoundError,
      );
    });

    it('returns the dashboard and its widgets when the actor is the creator', async () => {
      manager.findOne.mockResolvedValueOnce({ id: 'dash-1', createdBy: actorId, name: 'D1', sharedWith: [] });
      manager.find.mockResolvedValueOnce([{ id: 'w1' }]);

      const result = await service.getDashboard(tenantId, actorId, [], 'dash-1');

      expect(result.dashboard.name).toBe('D1');
      expect(result.widgets).toEqual([{ id: 'w1' }]);
    });

    it("ADR-0163: returns the dashboard when it isn't owned, but is shared with a role the caller currently holds", async () => {
      manager.findOne.mockResolvedValueOnce({
        id: 'dash-1',
        createdBy: 'someone-else',
        name: 'Exec Overview',
        sharedWith: ['manager', 'analyst'],
      });
      manager.find.mockResolvedValueOnce([{ id: 'w1' }]);

      const result = await service.getDashboard(tenantId, actorId, ['employee', 'analyst'], 'dash-1');

      expect(result.dashboard.name).toBe('Exec Overview');
    });
  });

  describe('updateDashboard', () => {
    const cheapMetric = {
      id: 'metric-1',
      name: 'adherence_trend',
      estimatedCostTier: MetricCostTier.CHEAP,
      validatedAt: new Date('2026-08-01T00:00:00Z'),
    };

    it('throws DashboardNotFoundError when no row matches', async () => {
      manager.findOne.mockResolvedValueOnce(null);

      await expect(
        service.updateDashboard(tenantId, actorId, 'dash-1', { name: 'D1', config: {}, widgets: [] }),
      ).rejects.toThrow(DashboardNotFoundError);
      expect(manager.update).not.toHaveBeenCalled();
      expect(manager.delete).not.toHaveBeenCalled();
    });

    it('ADR-0163: throws DashboardNotFoundError for a non-owner even when the dashboard is shared with a role they hold - sharing grants view access, not edit access', async () => {
      manager.findOne.mockResolvedValueOnce({ id: 'dash-1', createdBy: 'someone-else', sharedWith: ['manager'] });

      await expect(
        service.updateDashboard(tenantId, actorId, 'dash-1', { name: 'D1', config: {}, widgets: [] }),
      ).rejects.toThrow(DashboardNotFoundError);
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('validates every incoming widget metric the same way createDashboard does, before any write', async () => {
      manager.findOne.mockResolvedValueOnce({ id: 'dash-1', createdBy: actorId });
      manager.findOne.mockResolvedValueOnce({ ...cheapMetric, validatedAt: null });

      await expect(
        service.updateDashboard(tenantId, actorId, 'dash-1', {
          name: 'D1',
          config: {},
          widgets: [{ widgetType: 'kpi_tile', metricId: 'metric-1', position: {} }],
        }),
      ).rejects.toThrow(UnvalidatedMetricNotAllowedOnWidgetError);
      expect(manager.update).not.toHaveBeenCalled();
      expect(manager.delete).not.toHaveBeenCalled();
    });

    it('updates name/config, replaces every widget (delete-then-insert), and returns the fresh set', async () => {
      manager.findOne.mockResolvedValueOnce({ id: 'dash-1', createdBy: actorId, sharedWith: [] });
      manager.findOne.mockResolvedValueOnce(cheapMetric);
      manager.findOneByOrFail
        .mockResolvedValueOnce({ id: 'widget-2', dashboardId: 'dash-1', widgetType: 'line_chart' })
        .mockResolvedValueOnce({ id: 'dash-1', name: 'D1 renamed' });

      const result = await service.updateDashboard(tenantId, actorId, 'dash-1', {
        name: 'D1 renamed',
        config: { theme: 'light' },
        widgets: [{ widgetType: 'line_chart', metricId: 'metric-1', position: { x: 1 } }],
      });

      expect(manager.update).toHaveBeenCalledWith(
        expect.anything(),
        { id: 'dash-1' },
        expect.objectContaining({ name: 'D1 renamed', config: { theme: 'light' } }),
      );
      expect(manager.delete).toHaveBeenCalledWith(expect.anything(), { dashboardId: 'dash-1' });
      expect(manager.insert).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ dashboardId: 'dash-1', widgetType: 'line_chart', metricId: 'metric-1' }),
      );
      expect(result.widgets).toHaveLength(1);
      expect(result.dashboard.name).toBe('D1 renamed');
    });

    it('ADR-0163: replaces sharedWith when sharedWithRoles is supplied, and leaves it unchanged when omitted', async () => {
      manager.findOne.mockResolvedValueOnce({ id: 'dash-1', createdBy: actorId, sharedWith: ['manager'] });
      manager.findOneByOrFail.mockResolvedValue({ id: 'dash-1' });

      await service.updateDashboard(tenantId, actorId, 'dash-1', {
        name: 'D1',
        config: {},
        widgets: [],
        sharedWithRoles: ['finance', 'analyst'],
      });

      expect(manager.update).toHaveBeenCalledWith(
        expect.anything(),
        { id: 'dash-1' },
        expect.objectContaining({ sharedWith: ['finance', 'analyst'] }),
      );

      manager.findOne.mockResolvedValueOnce({ id: 'dash-2', createdBy: actorId, sharedWith: ['manager'] });
      await service.updateDashboard(tenantId, actorId, 'dash-2', { name: 'D2', config: {}, widgets: [] });

      expect(manager.update).toHaveBeenCalledWith(
        expect.anything(),
        { id: 'dash-2' },
        expect.objectContaining({ sharedWith: ['manager'] }),
      );
    });
  });

  describe('listMyDashboards', () => {
    it('fetches widgets for every dashboard, not an empty placeholder array', async () => {
      manager.find
        .mockResolvedValueOnce([
          { id: 'dash-1', createdBy: actorId, sharedWith: [] },
          { id: 'dash-2', createdBy: actorId, sharedWith: [] },
        ])
        .mockResolvedValueOnce([{ id: 'w1', dashboardId: 'dash-1' }])
        .mockResolvedValueOnce([]);

      const results = await service.listMyDashboards(tenantId, actorId, []);

      expect(results).toEqual([
        {
          dashboard: { id: 'dash-1', createdBy: actorId, sharedWith: [] },
          widgets: [{ id: 'w1', dashboardId: 'dash-1' }],
        },
        { dashboard: { id: 'dash-2', createdBy: actorId, sharedWith: [] }, widgets: [] },
      ]);
    });

    it('ADR-0163: "my dashboards" also includes dashboards owned by someone else but shared with a role the caller holds, excluding ones shared with roles the caller does not hold', async () => {
      manager.find
        .mockResolvedValueOnce([
          { id: 'dash-owned', createdBy: actorId, sharedWith: [] },
          { id: 'dash-shared-with-me', createdBy: 'someone-else', sharedWith: ['manager'] },
          { id: 'dash-shared-with-others', createdBy: 'someone-else', sharedWith: ['finance'] },
        ])
        .mockResolvedValueOnce([]) // widgets for dash-owned
        .mockResolvedValueOnce([]); // widgets for dash-shared-with-me

      const results = await service.listMyDashboards(tenantId, actorId, ['manager']);

      expect(results.map((r) => r.dashboard.id)).toEqual(['dash-owned', 'dash-shared-with-me']);
    });
  });
});
