import { Injectable, Logger } from '@nestjs/common';
import { createConnection } from 'mysql2/promise';
import { IntegrationConnector } from '../../../integrations/entities/integration-connector.entity';
import { VaultClientService } from '../../../vault/vault-client.service';
import { HistoricalChunkOutcome, HistoricalConnectorAdapter } from '../historical-connector-adapter';

interface MysqlCredentials {
  host: string;
  port?: number;
  database: string;
  username: string;
  password: string;
}

const MAX_ROWS_PER_CHUNK = 50000;
const QUERY_TIMEOUT_MS = 60000;

/**
 * Real MySQL historical connectivity - a separate adapter from
 * `DatabaseHistoricalAdapter`, not a `dbType` branch inside it. That
 * adapter is genuinely Postgres-specific (the `pg` driver, `$1`/`$2`
 * placeholders, `statement_timeout`) - MySQL's own wire protocol, driver
 * (`mysql2`), placeholder syntax (`?`), and timeout mechanism (a
 * client-enforced `QueryOptions.timeout`, not a server-side setting) are
 * different enough that folding them into one adapter would mean silently
 * picking the wrong one of two incompatible query languages based on a
 * flag, exactly the kind of generic-shape-hiding-a-real-difference this
 * platform's connectors avoid elsewhere (e.g. `TalkdeskHistoricalAdapter`
 * vs `NiceCxoneHistoricalAdapter` are separate files for the same reason).
 *
 * Reuses the *mechanism* `DatabaseHistoricalAdapter` already established -
 * `config.settings.historicalQueries[datasetKey]` is a tenant-authored SQL
 * template, the date range is always bound as real parameters (`?`, MySQL's
 * own placeholder, via `mysql2`'s server-side prepared statements - never
 * string-interpolated), never a fixed schema this platform invents. A
 * customer whose on-prem ACD already lands "all ACD events and everything"
 * into their own MySQL schema configures one query per dataset here,
 * against their own tables - this adapter doesn't know or assume anything
 * about that schema.
 */
@Injectable()
export class MysqlHistoricalAdapter implements HistoricalConnectorAdapter {
  readonly provider = 'mysql';
  readonly datasetKeys: readonly string[] = [];

  private readonly logger = new Logger(MysqlHistoricalAdapter.name);

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
      return failed(
        'no_query_configured',
        `No SQL query is configured for dataset "${datasetKey}" on this connector. Configure it under Data Sources -> Settings -> historicalQueries (MySQL syntax - "?" placeholders, not "$1"/"$2").`,
      );
    }

    const credentialReference = config.credentialReference as string | undefined;
    if (!credentialReference) {
      return failed('no_credentials_configured', 'This connector has no stored MySQL credentials.');
    }

    let credentials: MysqlCredentials;
    try {
      credentials = (await this.vault.read(credentialReference)) as unknown as MysqlCredentials;
    } catch (err) {
      return failed('credential_read_failed', (err as Error).message);
    }

    const requireSsl = settings.historicalDatabaseSsl !== false;
    let connection;
    try {
      connection = await createConnection({
        host: credentials.host,
        port: credentials.port ?? 3306,
        database: credentials.database,
        user: credentials.username,
        password: credentials.password,
        ssl: requireSsl ? { rejectUnauthorized: false } : undefined,
        connectTimeout: 10000,
      });
    } catch (err) {
      return failed('connection_failed', (err as Error).message);
    }

    let rows: Record<string, unknown>[];
    try {
      const [result] = await connection.execute({ sql: template, timeout: QUERY_TIMEOUT_MS }, [rangeStart, rangeEnd]);
      rows = (Array.isArray(result) ? (result as Record<string, unknown>[]) : []).slice(0, MAX_ROWS_PER_CHUNK);
    } catch (err) {
      return failed('query_failed', (err as Error).message);
    } finally {
      await connection.end().catch((err: Error) => this.logger.warn(`Failed to close MySQL historical connection: ${err.message}`));
    }

    return { status: 'completed', recordsFound: rows.length, recordsProcessed: rows.length, recordsFailed: 0, recordsDuplicate: 0, records: rows };
  }
}

function failed(reason: string, message: string): HistoricalChunkOutcome {
  return { status: 'failed', recordsFound: 0, recordsProcessed: 0, recordsFailed: 0, recordsDuplicate: 0, errorDetails: { reason, message } };
}
