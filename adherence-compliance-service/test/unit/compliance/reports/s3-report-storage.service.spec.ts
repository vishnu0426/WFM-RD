import { S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { parseS3Uri, S3ReportStorageService } from '../../../../src/compliance/reports/s3-report-storage.service';

jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

describe('parseS3Uri', () => {
  it('splits a canonical s3:// URI into bucket and key', () => {
    expect(parseS3Uri('s3://my-bucket/reports/tenant-1/report-1.csv')).toEqual({
      bucket: 'my-bucket',
      key: 'reports/tenant-1/report-1.csv',
    });
  });

  it('throws on a non-s3:// URI', () => {
    expect(() => parseS3Uri('https://example.com/file.csv')).toThrow('Not a valid s3:// URI');
  });
});

describe('S3ReportStorageService', () => {
  let sendSpy: jest.SpyInstance;
  let service: S3ReportStorageService;

  beforeEach(() => {
    process.env.COMPLIANCE_REPORTS_S3_BUCKET = 'test-bucket';
    sendSpy = jest.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
    service = new S3ReportStorageService();
  });

  afterEach(() => {
    delete process.env.COMPLIANCE_REPORTS_S3_BUCKET;
    jest.restoreAllMocks();
  });

  it('uploads with the configured bucket and returns the canonical s3:// URI', async () => {
    const result = await service.upload('reports/tenant-1/report-1.csv', 'a,b\n1,2\n', 'text/csv');

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Bucket: 'test-bucket',
          Key: 'reports/tenant-1/report-1.csv',
          Body: 'a,b\n1,2\n',
          ContentType: 'text/csv',
        }),
      }),
    );
    expect(result).toEqual({
      uri: 's3://test-bucket/reports/tenant-1/report-1.csv',
      bucket: 'test-bucket',
      key: 'reports/tenant-1/report-1.csv',
    });
  });

  it('computes a presigned download URL by parsing the stored fileUri back into bucket/key', async () => {
    (getSignedUrl as jest.Mock).mockResolvedValue('https://presigned.example.com/report-1.csv');

    const url = await service.getPresignedDownloadUrl('s3://test-bucket/reports/tenant-1/report-1.csv');

    expect(url).toBe('https://presigned.example.com/report-1.csv');
    expect(getSignedUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        input: expect.objectContaining({ Bucket: 'test-bucket', Key: 'reports/tenant-1/report-1.csv' }),
      }),
      { expiresIn: 3600 },
    );
  });

  it('deletes the object by parsing the stored fileUri back into bucket/key', async () => {
    await service.deleteObject('s3://test-bucket/reports/tenant-1/report-1.csv');

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ Bucket: 'test-bucket', Key: 'reports/tenant-1/report-1.csv' }),
      }),
    );
  });
});
