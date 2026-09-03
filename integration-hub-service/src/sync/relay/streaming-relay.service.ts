import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { withTenantConnection } from '../../database/with-tenant-connection';
import { SyncJobsService } from '../sync-jobs.service';
import { RelayAdapterRegistry } from './relay-adapter-registry.service';
import { StreamingRelaySession } from './streaming-relay-adapter';
import { NoActiveRelaySessionError } from '../errors/no-active-relay-session.error';
import { RelayNotSupportedForConnectorTypeError } from '../errors/relay-not-supported-for-connector-type.error';
import { isStreamingConnectorType } from '../../integrations/connector-type.utils';
import { ConnectorNotFoundError } from '../../connectors/errors/connector-not-found.error';
import { IntegrationConnector, SyncJobStatus } from '../../integrations/entities/integration-connector.entity';
import { SyncJob, SyncType } from '../../integrations/entities/sync-job.entity';

/**
 * §5c/§7 Phase 2's "streaming-relay base": connection-window `SyncJob`
 * lifecycle (§2.1's own comment on what `started_at`/`completed_at`/
 * `records_processed` mean for a streaming row) plus adapter dispatch,
 * with zero real provider adapters registered (Phase 6/6b's job). A
 * connector whose `provider` has no registered adapter fails its `start`
 * call cleanly - this is the correct, expected behavior for this phase.
 *
 * `liveSessions` is process-local, in-memory state - a real live
 * WebSocket/AES-session handle cannot be persisted to Postgres. A process
 * restart loses track of any live session's handle (so `stop` after a
 * restart can still close out the `SyncJob` row structurally, but cannot
 * call the adapter's own `disconnect()` on a handle it no longer holds) -
 * disclosed explicitly, not silently assumed away; multi-instance/restart-
 * safe relay ownership is Phase 6+'s scaling concern (§0/closing-note's
 * flagged fourth load-testing risk), not this phase's.
 */
@Injectable()
export class StreamingRelayService {
  private readonly logger = new Logger(StreamingRelayService.name);
  private readonly liveSessions = new Map<string, StreamingRelaySession>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly syncJobs: SyncJobsService,
    private readonly registry: RelayAdapterRegistry,
  ) {}

  async start(tenantId: string, connectorId: string): Promise<SyncJob> {
    const connector = await this.loadConnector(tenantId, connectorId);
    if (!isStreamingConnectorType(connector.connectorType)) {
      throw new RelayNotSupportedForConnectorTypeError(connector.connectorType);
    }

    const job = await this.syncJobs.enqueue(tenantId, connectorId, SyncType.STREAMING);
    const adapter = this.registry.find(connector.provider);
    if (!adapter) {
      return this.syncJobs.complete(tenantId, job.id, {
        status: SyncJobStatus.FAILED,
        recordsProcessed: 0,
        recordsFailed: 0,
        errorDetails: { reason: 'no_adapter_registered', provider: connector.provider },
      });
    }

    try {
      const session = await adapter.connect(connector, {
        onEventForwarded: () => {
          this.syncJobs.incrementCounts(tenantId, job.id, { processed: 1 }).catch((err: Error) => {
            this.logger.warn(`Failed to increment records_processed for job ${job.id}: ${err.message}`);
          });
        },
        onEventFailed: () => {
          this.syncJobs.incrementCounts(tenantId, job.id, { failed: 1 }).catch((err: Error) => {
            this.logger.warn(`Failed to increment records_failed for job ${job.id}: ${err.message}`);
          });
        },
      });
      this.liveSessions.set(connectorId, session);
      return this.syncJobs.markRunning(tenantId, job.id);
    } catch (err) {
      return this.syncJobs.complete(tenantId, job.id, {
        status: SyncJobStatus.FAILED,
        recordsProcessed: 0,
        recordsFailed: 0,
        errorDetails: { reason: 'adapter_connect_threw', message: (err as Error).message },
      });
    }
  }

  async stop(tenantId: string, connectorId: string): Promise<SyncJob> {
    const latest = await this.syncJobs.findLatestForConnector(tenantId, connectorId, SyncType.STREAMING);
    if (!latest || latest.status !== SyncJobStatus.RUNNING) {
      throw new NoActiveRelaySessionError(connectorId);
    }

    const session = this.liveSessions.get(connectorId);
    if (session) {
      const connector = await this.loadConnector(tenantId, connectorId);
      const adapter = this.registry.find(connector.provider);
      try {
        await adapter?.disconnect(session);
      } catch (err) {
        this.logger.warn(`Adapter disconnect failed for connector ${connectorId}: ${(err as Error).message}`);
      }
      this.liveSessions.delete(connectorId);
    }

    return this.syncJobs.complete(tenantId, latest.id, {
      status: SyncJobStatus.COMPLETED,
      recordsProcessed: latest.recordsProcessed,
      recordsFailed: latest.recordsFailed,
      recordsConflicted: null,
    });
  }

  async status(tenantId: string, connectorId: string): Promise<SyncJob | null> {
    return this.syncJobs.findLatestForConnector(tenantId, connectorId, SyncType.STREAMING);
  }

  private async loadConnector(tenantId: string, connectorId: string): Promise<IntegrationConnector> {
    const connector = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.findOne(IntegrationConnector, { where: { tenantId, id: connectorId } }),
    );
    if (!connector) {
      throw new ConnectorNotFoundError(connectorId);
    }
    return connector;
  }
}
