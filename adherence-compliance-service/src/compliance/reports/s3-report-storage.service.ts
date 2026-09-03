import { Injectable } from '@nestjs/common';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** §3.2/docs/adr/0105: a presigned URL good for 1 hour - long enough for a caller to start a download, short enough that a leaked URL isn't a standing access grant. */
const PRESIGNED_URL_EXPIRY_SECONDS = 3600;

export interface UploadedReport {
  /** Canonical `s3://bucket/key` location - stored in `ComplianceReport.fileUri`. */
  uri: string;
  bucket: string;
  key: string;
}

/**
 * docs/adr/0105: this platform's first S3 (or S3-compatible) integration,
 * in either language. `COMPLIANCE_REPORTS_S3_ENDPOINT`/`_FORCE_PATH_STYLE`
 * exist purely so this same client, with zero code branching, can point at
 * a local MinIO instance for real verification instead of real AWS - the
 * AWS SDK's own supported mechanism for any S3-compatible target, not a
 * platform-specific workaround. Credentials/region are read from the SDK's
 * own standard environment variables (`AWS_ACCESS_KEY_ID`/
 * `AWS_SECRET_ACCESS_KEY`/`AWS_REGION`) - no custom env var names invented
 * for those.
 */
@Injectable()
export class S3ReportStorageService {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    this.bucket = process.env.COMPLIANCE_REPORTS_S3_BUCKET ?? 'agno-wfm-compliance-reports-dev';
    this.client = new S3Client({
      endpoint: process.env.COMPLIANCE_REPORTS_S3_ENDPOINT,
      forcePathStyle: process.env.COMPLIANCE_REPORTS_S3_FORCE_PATH_STYLE === 'true',
    });
  }

  async upload(key: string, body: string, contentType: string): Promise<UploadedReport> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
    return { uri: `s3://${this.bucket}/${key}`, bucket: this.bucket, key };
  }

  /** `fileUri` is `s3://bucket/key` - parsed back into bucket/key rather than storing them separately, since the canonical location is the one thing a caller outside this service should ever need to persist. */
  async getPresignedDownloadUrl(fileUri: string): Promise<string> {
    const { bucket, key } = parseS3Uri(fileUri);
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    return getSignedUrl(this.client, command, { expiresIn: PRESIGNED_URL_EXPIRY_SECONDS });
  }

  /** docs/adr/0106: the retention lifecycle job's own paired half of a report delete - `DeleteObjectCommand` is idempotent by AWS's own design, so a second call against an already-deleted object is itself a success, not an error to handle specially here. */
  async deleteObject(fileUri: string): Promise<void> {
    const { bucket, key } = parseS3Uri(fileUri);
    await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
}

export function parseS3Uri(uri: string): { bucket: string; key: string } {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match) {
    throw new Error(`Not a valid s3:// URI: ${uri}`);
  }
  return { bucket: match[1], key: match[2] };
}
