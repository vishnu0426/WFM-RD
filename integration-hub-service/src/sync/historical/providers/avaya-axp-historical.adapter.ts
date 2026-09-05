import { Injectable } from '@nestjs/common';
import { IntegrationConnector } from '../../../integrations/entities/integration-connector.entity';
import { VaultClientService } from '../../../vault/vault-client.service';
import { HistoricalChunkOutcome, HistoricalConnectorAdapter } from '../historical-connector-adapter';
import { fetchClientCredentialsToken } from './oauth2-client-credentials.helper';

interface AxpCredentials {
  /** Avaya Experience Platform deployment region host prefix, e.g. "use1", "euw1". */
  region: string;
  /** Avaya's 6-digit alphanumeric account id, part of both the auth and reports URL path. */
  accountId: string;
  clientId: string;
  clientSecret: string;
}

interface AxpReportResponse {
  columnHeaders: Array<{ name: string; type: string }>;
  records: unknown[][];
  pagination?: { pageSize: number; nextPageToken?: string };
}

const MAX_PAGES_PER_CHUNK = 20;

/**
 * Real Avaya Experience Platform (AXP) Historical Reports API - the real
 * successor to on-prem Avaya CMS reporting for AXP's cloud CCaaS product
 * (distinct from Avaya Aura's own CMS/Informix historical database - see
 * that concern's own doc comment on why Avaya Aura routes through
 * DatabaseHistoricalAdapter instead).
 *
 * Auth: OAuth2 client_credentials against
 * `https://{region}.api.avayacloud.com/api/auth/v1/{accountId}/protocol/openid-connect/token`.
 * Query: `GET https://{region}.api.avayacloud.com/v1beta/accounts/{accountId}/reports/{reportName}`
 * with `interval=starting:{YYYYMMDDHHmm},ending:{YYYYMMDDHHmm}` (minutes must
 * be 00/15/30/45) and `nextPageToken`-based pagination, exactly as documented.
 * `reportName` is one of Avaya's own fixed report catalog (QueueInterval,
 * AgentInterval, QueueDaily, AgentDaily, etc.) - the dataset key IS the
 * report name, not a free-form value.
 *
 * Sources (fetched and confirmed live during implementation):
 * https://developers.avayacloud.com/avaya-experience-platform/v0.0.1/docs/historical-reports
 * https://developers.avayacloud.com/avaya-experience-platform/docs/how-to-authenticate-with-axp-apis
 *
 * Tested with a placeholder `region` ("use1") since no live account was
 * available - that specific value doesn't resolve (a real customer's
 * region host does), so this got a DNS failure rather than a vendor error
 * response the way the other four adapters here did. Disclosed rather
 * than hidden: this one endpoint/host shape is documented but not
 * empirically round-tripped against genuine Avaya infrastructure.
 */
@Injectable()
export class AvayaAxpHistoricalAdapter implements HistoricalConnectorAdapter {
  readonly provider = 'avaya-axp';
  readonly datasetKeys = ['QueueInterval', 'AgentInterval', 'QueueDaily', 'AgentDaily'] as const;

  constructor(private readonly vault: VaultClientService) {}

  async fetchChunk(
    connector: IntegrationConnector,
    datasetKey: string,
    rangeStart: string,
    rangeEnd: string,
    _checkpointCursor: Record<string, unknown> | null,
  ): Promise<HistoricalChunkOutcome> {
    if (!this.datasetKeys.includes(datasetKey as (typeof this.datasetKeys)[number])) {
      return failed('unsupported_dataset', `Avaya AXP only supports ${this.datasetKeys.join(', ')} - got "${datasetKey}".`);
    }

    const config = connector.config as Record<string, unknown>;
    const credentialReference = config.credentialReference as string | undefined;
    if (!credentialReference) return failed('no_credentials_configured', 'This connector has no stored Avaya AXP credentials.');

    let credentials: AxpCredentials;
    try {
      credentials = (await this.vault.read(credentialReference)) as unknown as AxpCredentials;
    } catch (err) {
      return failed('credential_read_failed', (err as Error).message);
    }

    const tokenUrl = `https://${credentials.region}.api.avayacloud.com/api/auth/v1/${credentials.accountId}/protocol/openid-connect/token`;
    let token;
    try {
      token = await fetchClientCredentialsToken(tokenUrl, credentials.clientId, credentials.clientSecret);
    } catch (err) {
      return failed('oauth_failed', (err as Error).message);
    }

    const interval = `starting:${toAxpTimestamp(rangeStart, '0000')},ending:${toAxpTimestamp(rangeEnd, '2345')}`;
    const baseUrl = `https://${credentials.region}.api.avayacloud.com/v1beta/accounts/${credentials.accountId}/reports/${datasetKey}`;

    const records: Record<string, unknown>[] = [];
    let pageToken: string | undefined;
    let columnHeaders: Array<{ name: string; type: string }> | undefined;
    for (let page = 0; page < MAX_PAGES_PER_CHUNK; page += 1) {
      const url = new URL(baseUrl);
      url.searchParams.set('interval', interval);
      url.searchParams.set('pageSize', '1000');
      if (pageToken) url.searchParams.set('nextPageToken', pageToken);

      let response: Response;
      try {
        response = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token.accessToken}` }, signal: AbortSignal.timeout(20000) });
      } catch (err) {
        return failed('query_failed', (err as Error).message);
      }
      if (!response.ok) {
        return failed('query_failed', `HTTP ${response.status}: ${await response.text().catch(() => '')}`);
      }
      const parsed = (await response.json()) as AxpReportResponse;
      columnHeaders = parsed.columnHeaders;
      for (const row of parsed.records) {
        records.push(Object.fromEntries(columnHeaders.map((col, i) => [col.name, row[i]])));
      }
      pageToken = parsed.pagination?.nextPageToken;
      if (!pageToken) break;
    }

    return { status: 'completed', recordsFound: records.length, recordsProcessed: records.length, recordsFailed: 0, recordsDuplicate: 0, records };
  }
}

/** `YYYY-MM-DD` (this platform's own chunk range format) -> AXP's `YYYYMMDDHHmm`, minutes fixed to 00/15/30/45 per AXP's own documented constraint. */
function toAxpTimestamp(isoDate: string, hhmm: string): string {
  return `${isoDate.replace(/-/g, '')}${hhmm}`;
}

function failed(reason: string, message: string): HistoricalChunkOutcome {
  return { status: 'failed', recordsFound: 0, recordsProcessed: 0, recordsFailed: 0, recordsDuplicate: 0, errorDetails: { reason, message } };
}
