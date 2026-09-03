import { IntegrationConnector, SyncJobStatus } from '../../integrations/entities/integration-connector.entity';
import { SyncJob } from '../../integrations/entities/sync-job.entity';

export interface BatchSyncOutcome {
  status: SyncJobStatus.COMPLETED | SyncJobStatus.FAILED | SyncJobStatus.PARTIAL_FAILURE;
  recordsProcessed: number;
  recordsFailed: number;
  recordsConflicted?: number | null;
  errorDetails?: Record<string, unknown> | null;
}

/**
 * §7 Phase 3/6b's real contract: field mapping, dry-run against Module 02's
 * bulk-import, then live sync (`hris`/`payroll`/`crm`) - none of that is
 * implemented by this interface itself. Phase 2 builds the shape and the
 * runner that calls it; zero adapters are registered until Phase 3.
 */
export interface BatchConnectorAdapter {
  readonly provider: string;
  /** `onRateLimited`, when passed, should be threaded down into every `withBackoffRetry` call this adapter makes - see that function's own doc comment and `BatchSyncRunnerService.runOne`'s construction of it. */
  sync(
    connector: IntegrationConnector,
    job: SyncJob,
    onRateLimited?: (delayMs: number) => Promise<void>,
  ): Promise<BatchSyncOutcome>;
}

export const BATCH_CONNECTOR_ADAPTERS = Symbol('BATCH_CONNECTOR_ADAPTERS');
