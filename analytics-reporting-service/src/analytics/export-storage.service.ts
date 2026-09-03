import { Injectable } from '@nestjs/common';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** §4.2's own doc comment reasoning (ADR-0105's precedent, restated here): a presigned URL good for 1 hour - long enough for a caller to start a download, short enough that a leaked URL isn't a standing access grant. */
const PRESIGNED_URL_EXPIRY_SECONDS = 3600;

export interface UploadedExport {
  /** Canonical `s3://bucket/key` location - stored in `AnalyticsExport.fileUri`. */
  uri: string;
}

/**
 * Own copy of adherence-compliance-service's `S3ReportStorageService`
 * (ADR-0039 precedent) - this module's first S3 (or S3-compatible)
 * integration. `ANALYTICS_EXPORTS_S3_ENDPOINT`/`_FORCE_PATH_STYLE` exist
 * purely so this same client, with zero code branching, can point at a
 * local MinIO instance for real verification instead of real AWS - the
 * AWS SDK's own supported mechanism for any S3-compatible target.
 * Credentials/region are read from the SDK's own standard environment
 * variables, no custom names invented for those. No `deleteObject` - no
 * retention/lifecycle job exists for exports in this phase (the migration
 * that creates `analytics_export` explains why: no §5b-equivalent legal
 * retention requirement exists anywhere in this module's own spec).
 */
@Injectable()
export class ExportStorageService {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    this.bucket = process.env.ANALYTICS_EXPORTS_S3_BUCKET ?? 'agno-wfm-analytics-exports-dev';
    this.client = new S3Client({
      endpoint: process.env.ANALYTICS_EXPORTS_S3_ENDPOINT,
      forcePathStyle: process.env.ANALYTICS_EXPORTS_S3_FORCE_PATH_STYLE === 'true',
    });
  }

  async upload(key: string, body: string, contentType: string): Promise<UploadedExport> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
    return { uri: `s3://${this.bucket}/${key}` };
  }

  /** `fileUri` is `s3://bucket/key` - parsed back into bucket/key rather than storing them separately, since the canonical location is the one thing a caller outside this service should ever need to persist. */
  async getPresignedDownloadUrl(fileUri: string): Promise<string> {
    const { bucket, key } = parseS3Uri(fileUri);
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    return getSignedUrl(this.client, command, { expiresIn: PRESIGNED_URL_EXPIRY_SECONDS });
  }
}

export function parseS3Uri(uri: string): { bucket: string; key: string } {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match) {
    throw new Error(`Not a valid s3:// URI: ${uri}`);
  }
  return { bucket: match[1], key: match[2] };
}
