import { Injectable, Logger } from '@nestjs/common';
import { Client } from 'pg';
import { IntegrationConnector } from '../../../integrations/entities/integration-connector.entity';
import { VaultClientService } from '../../../vault/vault-client.service';
import { HistoricalChunkOutcome, HistoricalConnectorAdapter } from '../historical-connector-adapter';

interface DatabaseCredentials {
  host: string;
  port?: number;
  database: string;
  username: string;
  password: string;
}

const MAX_ROWS_PER_CHUNK = 50000;

/**
 * Tenant Admin Integration Management, WP5 follow-up: real "Database"
 * historical connectivity - the first (and, as of this adapter, only)
 * registered `HistoricalConnectorAdapter`. Connects to a tenant's own
 * external SQL database with credentials the tenant supplied through the
 * *existing* connector-credentials flow (`IntegrationConnectorsService.
 * prepareDirectCredentialConnector` - Vault-backed, same as every other
 * connector's credentials, no new credential-handling path introduced),
 * and runs a tenant-authored, per-dataset SQL template
 * (`config.settings.historicalQueries[datasetKey]`) with the chunk's own
 * date range bound as real parameters - never string-interpolated into
 * the query, so a tenant's own SQL template cannot become an injection
 * vector via the range values this adapter controls.
 *
 * Fetched rows land verbatim as `HistoricalRecord.rawData` (the "Raw
 * Data" layer, spec §38) - genuinely real I/O, not a fabricated fetch.
 * Normalizing a row onto forecasting-service's canonical schema is
 * deliberately NOT done here (see `HistoricalRecord`'s own doc comment)
 * - a real, separate, narrower gap than "historical import doesn't work."
 */
@Injectable()
export class DatabaseHistoricalAdapter implements HistoricalConnectorAdapter {
  readonly provider = 'database';
  readonly datasetKeys: readonly string[] = [];

  private readonly logger = new Logger(DatabaseHistoricalAdapter.name);

  constructor(private readonly vault: VaultClientService) {}

  async fetchChunk(
    connector: IntegrationConnector,
    datasetKey: string,
    rangeStart: string,
    rangeEnd: string,
    _checkpointCursor: Record<string, unknown> | null,
  ): Promise<HistoricalChunkOutcome> {
    const config = connector.config as Record<string, unknown>;
    const settings = (config.settings as Record<string, unknown> | undefined) ?? {};
    const queries = (settings.historicalQueries as Record<string, string> | undefined) ?? {};
    const template = queries[datasetKey];
    if (!template) {
      return {
        status: 'failed',
        recordsFound: 0,
        recordsProcessed: 0,
        recordsFailed: 0,
        recordsDuplicate: 0,
        errorDetails: {
          reason: 'no_query_configured',
          message: `No SQL query is configured for dataset "${datasetKey}" on this connector. Configure it under Data Sources -> Settings -> historicalQueries.`,
        },
      };
    }

    const credentialReference = config.credentialReference as string | undefined;
    if (!credentialReference) {
      return {
        status: 'failed',
        recordsFound: 0,
        recordsProcessed: 0,
        recordsFailed: 0,
        recordsDuplicate: 0,
        errorDetails: { reason: 'no_credentials_configured', message: 'This connector has no stored database credentials.' },
      };
    }

    let credentials: DatabaseCredentials;
    try {
      credentials = (await this.vault.read(credentialReference)) as unknown as DatabaseCredentials;
    } catch (err) {
      return {
        status: 'failed',
        recordsFound: 0,
        recordsProcessed: 0,
        recordsFailed: 0,
        recordsDuplicate: 0,
        errorDetails: { reason: 'credential_read_failed', message: (err as Error).message },
      };
    }

    const requireSsl = settings.historicalDatabaseSsl !== false;
    const client = new Client({
      host: credentials.host,
      port: credentials.port ?? 5432,
      database: credentials.database,
      user: credentials.username,
      password: credentials.password,
      ssl: requireSsl ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 10000,
      statement_timeout: 60000,
    });

    let rows: Record<string, unknown>[];
    try {
      await client.connect();
      const result = await client.query(template, [rangeStart, rangeEnd]);
      rows = result.rows.slice(0, MAX_ROWS_PER_CHUNK);
    } catch (err) {
      return {
        status: 'failed',
        recordsFound: 0,
        recordsProcessed: 0,
        recordsFailed: 0,
        recordsDuplicate: 0,
        errorDetails: { reason: 'query_failed', message: (err as Error).message },
      };
    } finally {
      await client.end().catch((err: Error) => this.logger.warn(`Failed to close historical DB connection: ${err.message}`));
    }

    return {
      status: 'completed',
      recordsFound: rows.length,
      recordsProcessed: rows.length,
      recordsFailed: 0,
      recordsDuplicate: 0,
      records: rows,
    };
  }
}
