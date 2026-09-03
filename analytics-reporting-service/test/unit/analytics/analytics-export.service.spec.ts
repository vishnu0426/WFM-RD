import { AnalyticsExportService } from '../../../src/analytics/analytics-export.service';
import { AnalyticsExportStatus } from '../../../src/analytics/entities/analytics-export.entity';
import {
  AnalyticsExportNotFoundError,
  AnalyticsExportNotReadyError,
} from '../../../src/analytics/errors/analytics-export-not-found.error';
import { MetricsService } from '../../../src/common/metrics/metrics.service';

describe('AnalyticsExportService', () => {
  let dataSource: { transaction: jest.Mock };
  let manager: {
    findOne: jest.Mock;
    find: jest.Mock;
    insert: jest.Mock;
    findOneByOrFail: jest.Mock;
    update: jest.Mock;
    query: jest.Mock;
  };
  let metricQueryEngine: { queryForExport: jest.Mock };
  let storage: { upload: jest.Mock; getPresignedDownloadUrl: jest.Mock };
  let metrics: MetricsService;
  let service: AnalyticsExportService;

  const tenantId = 'tenant-1';
  const actorId = 'actor-1';

  beforeEach(() => {
    manager = {
      findOne: jest.fn(),
      find: jest.fn(),
      insert: jest.fn(),
      findOneByOrFail: jest.fn(),
      update: jest.fn(),
      query: jest.fn().mockResolvedValue(undefined),
    };
    dataSource = { transaction: jest.fn((work: (m: unknown) => unknown) => work(manager)) };
    metricQueryEngine = { queryForExport: jest.fn() };
    storage = { upload: jest.fn(), getPresignedDownloadUrl: jest.fn() };
    metrics = new MetricsService();
    service = new AnalyticsExportService(dataSource as any, metricQueryEngine as any, storage as any, metrics);
  });

  describe('requestExport', () => {
    it('inserts a pending row and triggers generation exactly once for a genuinely new request', async () => {
      manager.findOne.mockResolvedValueOnce(null); // no idempotency match
      manager.findOneByOrFail.mockResolvedValueOnce({
        id: 'export-1',
        status: AnalyticsExportStatus.PENDING,
      });
      const generateSpy = jest.spyOn(service as any, 'generate').mockResolvedValue(undefined);

      const row = await service.requestExport(tenantId, actorId, { metricName: 'adherence_trend' });

      expect(manager.insert).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ tenantId, requestedBy: actorId, metricName: 'adherence_trend' }),
      );
      expect(row.id).toBe('export-1');
      expect(generateSpy).toHaveBeenCalledWith(tenantId, 'export-1');
    });

    it('returns the existing row for a repeated Idempotency-Key and never inserts or triggers generation again', async () => {
      const existing = { id: 'export-1', status: AnalyticsExportStatus.COMPLETED };
      manager.findOne.mockResolvedValueOnce(existing);
      const generateSpy = jest.spyOn(service as any, 'generate').mockResolvedValue(undefined);

      const row = await service.requestExport(tenantId, actorId, {
        metricName: 'adherence_trend',
        idempotencyKey: 'key-1',
      });

      expect(row).toBe(existing);
      expect(manager.insert).not.toHaveBeenCalled();
      expect(generateSpy).not.toHaveBeenCalled();
    });

    it('scopes the idempotency lookup to (tenantId, idempotencyKey)', async () => {
      manager.findOne.mockResolvedValueOnce(null);
      manager.findOneByOrFail.mockResolvedValueOnce({ id: 'export-1' });
      jest.spyOn(service as any, 'generate').mockResolvedValue(undefined);

      await service.requestExport(tenantId, actorId, { metricName: 'adherence_trend', idempotencyKey: 'key-1' });

      expect(manager.findOne).toHaveBeenCalledWith(expect.anything(), {
        where: { tenantId, idempotencyKey: 'key-1' },
      });
    });
  });

  describe('generate (called directly - the fire-and-forget internals, not the public entry point)', () => {
    function stubExportRow(overrides: Record<string, unknown> = {}) {
      manager.findOneByOrFail.mockResolvedValue({
        id: 'export-1',
        tenantId,
        metricName: 'adherence_trend',
        filter: {},
        ...overrides,
      });
    }

    it('builds a CSV with a data_as_of column, uploads it, and marks the row completed with the real row count', async () => {
      stubExportRow();
      metricQueryEngine.queryForExport.mockResolvedValueOnce({
        columns: ['period_start', 'period_end', 'period_type', 'avg_adherence_pct'],
        rows: [
          {
            period_start: new Date('2026-08-01T00:00:00Z'),
            period_end: new Date('2026-08-02T00:00:00Z'),
            period_type: 'day',
            avg_adherence_pct: '95.50',
          },
        ],
        dataAsOf: new Date('2026-08-11T00:00:00Z'),
      });
      storage.upload.mockResolvedValueOnce({ uri: 's3://bucket/tenant-1/export-1.csv' });

      await (service as any).generate(tenantId, 'export-1');

      const [key, csv, contentType] = storage.upload.mock.calls[0];
      expect(key).toBe('tenant-1/export-1.csv');
      expect(contentType).toBe('text/csv');
      expect(csv).toContain('period_start,period_end,period_type,avg_adherence_pct,data_as_of');
      expect(csv).toContain('95.50');
      expect(csv).toContain('2026-08-11T00:00:00.000Z');

      expect(manager.update).toHaveBeenCalledWith(
        expect.anything(),
        { id: 'export-1' },
        expect.objectContaining({
          status: AnalyticsExportStatus.COMPLETED,
          fileUri: 's3://bucket/tenant-1/export-1.csv',
          rowCount: 1,
        }),
      );
      const values = (await metrics.getRegistry().getSingleMetric('analytics_exports_total')?.get())?.values;
      expect(values).toEqual([expect.objectContaining({ labels: { result: 'completed' } })]);
    });

    it('marks the row failed with the real error message when the query engine rejects it (e.g. an unknown metric), and never throws out of generate itself', async () => {
      stubExportRow({ metricName: 'unknown_metric' });
      metricQueryEngine.queryForExport.mockRejectedValueOnce(new Error('No MetricDefinition named "unknown_metric"'));

      await expect((service as any).generate(tenantId, 'export-1')).resolves.toBeUndefined();

      expect(manager.update).toHaveBeenCalledWith(
        expect.anything(),
        { id: 'export-1' },
        expect.objectContaining({
          status: AnalyticsExportStatus.FAILED,
          errorMessage: 'No MetricDefinition named "unknown_metric"',
        }),
      );
      expect(storage.upload).not.toHaveBeenCalled();
      const values = (await metrics.getRegistry().getSingleMetric('analytics_exports_total')?.get())?.values;
      expect(values).toEqual([expect.objectContaining({ labels: { result: 'failed' } })]);
    });
  });

  describe('listExports', () => {
    it("scopes to the actor's own requests, newest first", async () => {
      const rows = [{ id: 'export-2' }, { id: 'export-1' }];
      manager.find.mockResolvedValueOnce(rows);

      const result = await service.listExports(tenantId, actorId);

      expect(manager.find).toHaveBeenCalledWith(expect.anything(), {
        where: { requestedBy: actorId },
        order: { requestedAt: 'DESC' },
      });
      expect(result).toEqual(rows);
    });
  });

  describe('getExport', () => {
    it('throws AnalyticsExportNotFoundError when the row does not exist or was requested by someone else', async () => {
      manager.findOne.mockResolvedValueOnce(null);
      await expect(service.getExport(tenantId, actorId, 'export-1')).rejects.toThrow(AnalyticsExportNotFoundError);

      manager.findOne.mockResolvedValueOnce({ id: 'export-1', requestedBy: 'someone-else' });
      await expect(service.getExport(tenantId, actorId, 'export-1')).rejects.toThrow(AnalyticsExportNotFoundError);
    });
  });

  describe('getDownloadUrl', () => {
    it('throws AnalyticsExportNotReadyError for a pending or failed export', async () => {
      manager.findOne.mockResolvedValueOnce({
        id: 'export-1',
        requestedBy: actorId,
        status: AnalyticsExportStatus.PENDING,
      });
      await expect(service.getDownloadUrl(tenantId, actorId, 'export-1')).rejects.toThrow(AnalyticsExportNotReadyError);
      expect(storage.getPresignedDownloadUrl).not.toHaveBeenCalled();
    });

    it('returns a presigned URL for a completed export', async () => {
      manager.findOne.mockResolvedValueOnce({
        id: 'export-1',
        requestedBy: actorId,
        status: AnalyticsExportStatus.COMPLETED,
        fileUri: 's3://bucket/key.csv',
      });
      storage.getPresignedDownloadUrl.mockResolvedValueOnce('https://presigned.example/key.csv');

      const url = await service.getDownloadUrl(tenantId, actorId, 'export-1');

      expect(url).toBe('https://presigned.example/key.csv');
      expect(storage.getPresignedDownloadUrl).toHaveBeenCalledWith('s3://bucket/key.csv');
    });
  });
});
