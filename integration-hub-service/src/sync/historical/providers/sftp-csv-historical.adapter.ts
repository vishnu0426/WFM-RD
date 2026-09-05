import { Injectable } from '@nestjs/common';
// `ssh2-sftp-client` is a plain CJS `module.exports = SftpClient` with no
// named exports, and this project's tsconfig has `esModuleInterop: false`
// - a default import here compiles to `.default` on the raw require()
// result, which doesn't exist (confirmed at runtime: "is not a
// constructor"). `import ... = require(...)` maps directly to a plain
// `require()` call with no interop-shim assumption, matching what this
// package actually exports.
import SftpClient = require('ssh2-sftp-client');
import { parse } from 'csv-parse/sync';
import { IntegrationConnector } from '../../../integrations/entities/integration-connector.entity';
import { VaultClientService } from '../../../vault/vault-client.service';
import { HistoricalChunkOutcome, HistoricalConnectorAdapter } from '../historical-connector-adapter';

interface SftpCredentials {
  host: string;
  port?: number;
  username: string;
  /** Exactly one of password/privateKey is required - real SFTP/SSH auth has no third mode. */
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

interface SftpCsvDatasetConfig {
  /** Absolute remote directory this dataset's files live in. */
  remoteDir: string;
  /** File name template with a "{date}" placeholder substituted per calendar day (YYYY-MM-DD) in the chunk's range - the real, common "one file per day" drop shape. A tenant whose files aren't per-day (a single rolling file, say) sets a pattern with no "{date}" token, and every day in the range resolves to the same file - fetched and parsed once per chunk, not once per day, since `fetchedPaths` below dedupes by resolved path. */
  fileNamePattern: string;
  delimiter?: string;
  /** true (default): first row is the header, used as column names. Array: no header row in the file - these are the column names, in order, matching csv-parse's own `columns` option shape. */
  hasHeaderRow?: boolean | string[];
}

const MAX_ROWS_PER_CHUNK = 50000;

/**
 * Real SFTP + CSV historical connectivity - not a fixed vendor, and
 * deliberately not tied to one named customer: the shape a tenant's
 * on-prem system drops historical exports onto an SFTP server as
 * dated CSV files is common across many real ACD/HRIS/payroll systems,
 * and SFTP/CSV are themselves fully real, standard, well-defined
 * protocols (unlike a vendor REST API, there's no unknowable "real
 * contract" a generic shape could be hiding) - this is the same
 * "real protocol, tenant supplies deployment-specific details" posture
 * `DatabaseHistoricalAdapter`/`MysqlHistoricalAdapter` already established
 * for a tenant's own SQL database, applied to a tenant's own file drop.
 *
 * Auth: password or private key (with optional passphrase) via `ssh2-sftp-
 * client` (wraps the real `ssh2` SSH2 client library) - real SFTP has no
 * third auth mode.
 *
 * Per chunk (this platform's own 7-day date-range windows): resolves one
 * file path per calendar day by substituting "{date}" in the tenant's own
 * `fileNamePattern`, checks each for existence (a missing day is a real,
 * legitimate "no export that day" - not an error), downloads and parses
 * whichever exist via `csv-parse` (RFC 4180-compliant - handles quoted
 * fields/embedded commas correctly, unlike a naive string split), and
 * accumulates rows across the whole chunk. A parse failure on any one
 * file fails the whole chunk with the offending file path named in
 * `errorDetails` - never silently skipped.
 */
@Injectable()
export class SftpCsvHistoricalAdapter implements HistoricalConnectorAdapter {
  readonly provider = 'sftp-csv';
  readonly datasetKeys: readonly string[] = [];

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
    const datasets = (settings.sftpCsv as Record<string, SftpCsvDatasetConfig> | undefined) ?? {};
    const datasetConfig = datasets[datasetKey];
    if (!datasetConfig?.remoteDir || !datasetConfig?.fileNamePattern) {
      return failed(
        'no_dataset_configured',
        `No SFTP/CSV file pattern is configured for dataset "${datasetKey}" on this connector. Configure it under Data Sources -> Settings -> sftpCsv.`,
      );
    }

    const credentialReference = config.credentialReference as string | undefined;
    if (!credentialReference) return failed('no_credentials_configured', 'This connector has no stored SFTP credentials.');

    let credentials: SftpCredentials;
    try {
      credentials = (await this.vault.read(credentialReference)) as unknown as SftpCredentials;
    } catch (err) {
      return failed('credential_read_failed', (err as Error).message);
    }
    if (!credentials.password && !credentials.privateKey) {
      return failed('invalid_credentials', 'Vault secret has neither password nor privateKey - SFTP requires one of the two.');
    }

    const client = new SftpClient();
    try {
      await client.connect({
        host: credentials.host,
        port: credentials.port ?? 22,
        username: credentials.username,
        password: credentials.password,
        privateKey: credentials.privateKey,
        passphrase: credentials.passphrase,
        readyTimeout: 15000,
      });
    } catch (err) {
      return failed('connection_failed', (err as Error).message);
    }

    const records: Record<string, unknown>[] = [];
    try {
      const remotePaths = new Set<string>();
      for (const date of eachDate(rangeStart, rangeEnd)) {
        const fileName = datasetConfig.fileNamePattern.replace('{date}', date);
        remotePaths.add(`${datasetConfig.remoteDir.replace(/\/$/, '')}/${fileName}`);
      }

      for (const remotePath of remotePaths) {
        const exists = await client.exists(remotePath);
        if (!exists || exists === 'd') continue; // no file that day, or a directory matched the pattern - not an error either way.

        let text: string;
        try {
          const buffer = (await client.get(remotePath)) as Buffer;
          text = buffer.toString('utf8');
        } catch (err) {
          return failed('file_download_failed', `${remotePath}: ${(err as Error).message}`);
        }

        let rows: Record<string, unknown>[];
        try {
          rows = parse(text, {
            columns: datasetConfig.hasHeaderRow === false ? undefined : (datasetConfig.hasHeaderRow ?? true),
            delimiter: datasetConfig.delimiter ?? ',',
            skip_empty_lines: true,
            trim: true,
          }) as unknown as Record<string, unknown>[];
        } catch (err) {
          return failed('csv_parse_failed', `${remotePath}: ${(err as Error).message}`);
        }

        records.push(...rows);
        if (records.length >= MAX_ROWS_PER_CHUNK) break;
      }
    } finally {
      await client.end().catch(() => undefined);
    }

    const trimmed = records.slice(0, MAX_ROWS_PER_CHUNK);
    return { status: 'completed', recordsFound: trimmed.length, recordsProcessed: trimmed.length, recordsFailed: 0, recordsDuplicate: 0, records: trimmed };
  }
}

/** Every calendar date (YYYY-MM-DD, inclusive) from start to end - this platform's own chunk range format. */
function* eachDate(rangeStart: string, rangeEnd: string): Generator<string> {
  const start = new Date(`${rangeStart}T00:00:00Z`);
  const end = new Date(`${rangeEnd}T00:00:00Z`);
  for (let d = start; d.getTime() <= end.getTime(); d = new Date(d.getTime() + 86400000)) {
    yield d.toISOString().slice(0, 10);
  }
}

function failed(reason: string, message: string): HistoricalChunkOutcome {
  return { status: 'failed', recordsFound: 0, recordsProcessed: 0, recordsFailed: 0, recordsDuplicate: 0, errorDetails: { reason, message } };
}
