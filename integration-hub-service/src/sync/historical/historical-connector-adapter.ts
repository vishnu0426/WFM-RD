import { IntegrationConnector } from '../../integrations/entities/integration-connector.entity';

export interface HistoricalChunkOutcome {
  status: 'completed' | 'failed';
  recordsFound: number;
  recordsProcessed: number;
  recordsFailed: number;
  recordsDuplicate: number;
  /** Opaque to the runner - passed back unchanged on the next chunk/retry attempt so a provider that paginates within a single day can resume mid-chunk. */
  checkpointCursor?: Record<string, unknown> | null;
  errorDetails?: Record<string, unknown> | null;
}

/**
 * Tenant Admin Integration Management, WP5 (plan decision #6). Mirrors
 * `BatchConnectorAdapter`'s own "shape now, adapters later" precedent
 * exactly (see that interface's own doc comment - "Phase 2 builds the
 * shape and the runner that calls it; zero adapters are registered until
 * Phase 3"). As of WP5, zero providers implement this - confirmed by
 * reading every file in `sync/batch/providers/` and the on-prem
 * collector, none of which expose a date-ranged historical fetch. The
 * runner (`HistoricalBackfillRunnerService`) fails closed with
 * `HistoricalImportNotSupportedError` for every connector until a real
 * adapter is registered here, rather than fabricating a fetch.
 */
export interface HistoricalConnectorAdapter {
  readonly provider: string;
  readonly datasetKeys: readonly string[];
  fetchChunk(
    connector: IntegrationConnector,
    datasetKey: string,
    rangeStart: string,
    rangeEnd: string,
    checkpointCursor: Record<string, unknown> | null,
  ): Promise<HistoricalChunkOutcome>;
}

export const HISTORICAL_CONNECTOR_ADAPTERS = Symbol('HISTORICAL_CONNECTOR_ADAPTERS');
