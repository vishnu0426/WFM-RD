import { RetentionLifecycleJobService } from '../../../../src/compliance/reports/retention-lifecycle-job.service';
import { MetricsService } from '../../../../src/common/metrics/metrics.service';
import { S3ReportStorageService } from '../../../../src/compliance/reports/s3-report-storage.service';

describe('RetentionLifecycleJobService', () => {
  let pool: { query: jest.Mock };
  let deleteObject: jest.Mock;
  let recordRetentionLifecycleJobRun: jest.Mock;
  let recordRetentionLifecycleDeletion: jest.Mock;
  let service: RetentionLifecycleJobService;

  function buildService(config: Record<string, number> = {}): RetentionLifecycleJobService {
    pool = { query: jest.fn() };
    deleteObject = jest.fn().mockResolvedValue(undefined);
    recordRetentionLifecycleJobRun = jest.fn();
    recordRetentionLifecycleDeletion = jest.fn();
    const stubConfig = { get: (key: string) => config[key] } as unknown as ConstructorParameters<
      typeof RetentionLifecycleJobService
    >[1];
    const stubMetrics = {
      recordRetentionLifecycleJobRun,
      recordRetentionLifecycleDeletion,
    } as unknown as MetricsService;
    const stubS3 = { deleteObject } as unknown as S3ReportStorageService;
    return new RetentionLifecycleJobService(pool as never, stubConfig, stubMetrics, stubS3);
  }

  beforeEach(() => {
    service = buildService();
  });

  it('selects expired, non-legal-held rows with a batch size limit, defaulting to 100', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await service.sweepExpiredReports();
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('WHERE retention_expires_at < now() AND NOT legal_hold');
    expect(params).toEqual([100]);
  });

  it('honors a configured batch size', async () => {
    service = buildService({ RETENTION_LIFECYCLE_BATCH_SIZE: 25 });
    pool.query.mockResolvedValueOnce({ rows: [] });
    await service.sweepExpiredReports();
    expect(pool.query.mock.calls[0][1]).toEqual([25]);
  });

  it('deletes the S3 object before the Postgres row, for a report that has a fileUri', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'report-1', file_uri: 's3://bucket/key.csv' }] });
    pool.query.mockResolvedValueOnce(undefined); // the DELETE

    await service.sweepExpiredReports();

    expect(deleteObject).toHaveBeenCalledWith('s3://bucket/key.csv');
    expect(pool.query).toHaveBeenCalledWith('DELETE FROM compliance.compliance_report WHERE id = $1;', ['report-1']);
    // S3 delete must be awaited before the Postgres DELETE call is issued.
    const s3CallOrder = deleteObject.mock.invocationCallOrder[0];
    const deleteCallOrder = pool.query.mock.invocationCallOrder[1];
    expect(s3CallOrder).toBeLessThan(deleteCallOrder);
    expect(recordRetentionLifecycleDeletion).toHaveBeenCalledWith('deleted');
  });

  it('skips the S3 delete for a report with no fileUri (never generated a file - e.g. still pending)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'report-1', file_uri: null }] });
    pool.query.mockResolvedValueOnce(undefined);

    await service.sweepExpiredReports();

    expect(deleteObject).not.toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledWith('DELETE FROM compliance.compliance_report WHERE id = $1;', ['report-1']);
  });

  it('records a deletion error for one row without aborting the rest of the batch', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: 'report-1', file_uri: 's3://bucket/key1.csv' },
        { id: 'report-2', file_uri: 's3://bucket/key2.csv' },
      ],
    });
    deleteObject.mockRejectedValueOnce(new Error('S3 unreachable'));
    pool.query.mockResolvedValueOnce(undefined); // report-2's DELETE (report-1 never reaches its DELETE)

    await service.sweepExpiredReports();

    expect(recordRetentionLifecycleDeletion).toHaveBeenCalledWith('error');
    expect(recordRetentionLifecycleDeletion).toHaveBeenCalledWith('deleted');
    expect(pool.query).toHaveBeenCalledWith('DELETE FROM compliance.compliance_report WHERE id = $1;', ['report-2']);
    expect(pool.query).not.toHaveBeenCalledWith('DELETE FROM compliance.compliance_report WHERE id = $1;', [
      'report-1',
    ]);
  });

  describe('tick', () => {
    it('records a successful run and does not throw', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });
      await expect(service.tick()).resolves.toBeUndefined();
      expect(recordRetentionLifecycleJobRun).toHaveBeenCalledWith('success');
    });

    it('records an error run and swallows the failure, never throwing out of the scheduled tick', async () => {
      pool.query.mockRejectedValueOnce(new Error('DB unreachable'));
      await expect(service.tick()).resolves.toBeUndefined();
      expect(recordRetentionLifecycleJobRun).toHaveBeenCalledWith('error');
    });

    it('does not run a second sweep concurrently while one is already in progress', async () => {
      let resolveFirstQuery: (value: { rows: never[] }) => void;
      pool.query.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstQuery = resolve;
          }),
      );

      const first = service.tick();
      const second = service.tick();
      resolveFirstQuery!({ rows: [] });
      await Promise.all([first, second]);

      expect(pool.query).toHaveBeenCalledTimes(1);
    });
  });
});
