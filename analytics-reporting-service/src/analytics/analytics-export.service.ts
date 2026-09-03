import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { withTenantConnection } from '../database/with-tenant-connection';
import { AnalyticsExport, AnalyticsExportStatus } from './entities/analytics-export.entity';
import { MetricQueryEngineService, MetricQueryFilter } from './metric-query-engine.service';
import { ExportStorageService } from './export-storage.service';
import { toCsv } from './csv';
import { AnalyticsExportNotFoundError, AnalyticsExportNotReadyError } from './errors/analytics-export-not-found.error';
import { MetricsService } from '../common/metrics/metrics.service';

export interface RequestExportInput {
  metricName: string;
  filter?: MetricQueryFilter;
  idempotencyKey?: string;
}

/**
 * Phase 6 (§4.2/§1). "Async job, same pattern as Module 08's report
 * generator" - confirmed against that service's actual code (ADR-0105),
 * not assumed: **fire-and-forget, in-process, no separate worker/queue**.
 * `requestExport` inserts a `pending` row and returns it immediately; the
 * real generation (`generate`, private) is invoked without being awaited,
 * updating the row to `completed`/`failed` when it finishes. Same
 * disclosed consequence as Module 08's own copy of this pattern: a crash
 * mid-generation leaves a row stuck at `pending` forever - no reaper
 * exists, matching that module's own accepted tradeoff for a low-volume,
 * I/O-bound workload.
 *
 * **Idempotency-Key is real here**, unlike Module 08's own report
 * generator (confirmed to have none, by inspecting its actual code, not
 * assumed from the spec's "same pattern" phrasing) - this module's own
 * §4.2 explicitly requires it. Implemented via a Postgres partial unique
 * index (`idx_analytics_export_tenant_idempotency_key`) plus a proactive
 * pre-check, not this platform's Redis-backed generic idempotency
 * interceptor (root `src/common/http/idempotency.interceptor.ts` - not
 * reachable from this standalone service) or `scheduling-service`'s own
 * Postgres `idempotency_keys` table (a separate service's own schema) -
 * Postgres is this service's only stateful dependency already, so
 * reusing it here needs no new infrastructure.
 */
@Injectable()
export class AnalyticsExportService {
  private readonly logger = new Logger(AnalyticsExportService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly metricQueryEngine: MetricQueryEngineService,
    private readonly storage: ExportStorageService,
    private readonly metrics: MetricsService,
  ) {}

  async requestExport(tenantId: string, actorId: string, input: RequestExportInput): Promise<AnalyticsExport> {
    const { row, isNew } = await withTenantConnection(this.dataSource, tenantId, async (manager) => {
      if (input.idempotencyKey) {
        const existing = await manager.findOne(AnalyticsExport, {
          where: { tenantId, idempotencyKey: input.idempotencyKey },
        });
        if (existing) {
          return { row: existing, isNew: false };
        }
      }

      const id = randomUUID();
      await manager.insert(AnalyticsExport, {
        id,
        tenantId,
        requestedBy: actorId,
        metricName: input.metricName,
        filter: asJsonbValue(input.filter ?? {}),
        idempotencyKey: input.idempotencyKey ?? null,
        status: AnalyticsExportStatus.PENDING,
      });
      return { row: await manager.findOneByOrFail(AnalyticsExport, { id }), isNew: true };
    });

    // A retry on the same Idempotency-Key returns the existing row above
    // without ever re-triggering generation - only a genuinely new row
    // starts one.
    if (isNew) {
      void this.generate(tenantId, row.id).catch((err: Error) => {
        this.logger.error(`Unhandled error generating analytics export ${row.id}: ${err.message}`, err.stack);
      });
    }
    return row;
  }

  /**
   * §5's export history list - had no backend surface at all before this
   * (only single-export-by-id existed, `GET .../{id}`, this controller's
   * own literal §4.2 spec). Own-requests-only, newest first - same
   * "requestedBy === actorId" ownership scoping `getExport`/`getDownloadUrl`
   * already enforce, same list shape Module 08's own
   * `ComplianceReportService.listReports` precedent established for the
   * identical gap in that module's report history page.
   */
  async listExports(tenantId: string, actorId: string): Promise<AnalyticsExport[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.find(AnalyticsExport, { where: { requestedBy: actorId }, order: { requestedAt: 'DESC' } }),
    );
  }

  async getExport(tenantId: string, actorId: string, id: string): Promise<AnalyticsExport> {
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const row = await manager.findOne(AnalyticsExport, { where: { id } });
      if (!row || row.requestedBy !== actorId) {
        throw new AnalyticsExportNotFoundError(id);
      }
      return row;
    });
  }

  async getDownloadUrl(tenantId: string, actorId: string, id: string): Promise<string> {
    const row = await this.getExport(tenantId, actorId, id);
    if (row.status !== AnalyticsExportStatus.COMPLETED || !row.fileUri) {
      throw new AnalyticsExportNotReadyError(id, row.status);
    }
    return this.storage.getPresignedDownloadUrl(row.fileUri);
  }

  private async generate(tenantId: string, exportId: string): Promise<void> {
    const exportRow = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.findOneByOrFail(AnalyticsExport, { id: exportId }),
    );
    try {
      const filter = exportRow.filter as MetricQueryFilter;
      const { columns, rows, dataAsOf } = await this.metricQueryEngine.queryForExport(
        tenantId,
        exportRow.metricName,
        filter,
      );
      const header = [...columns, 'data_as_of'];
      const csvRows = rows.map((row) => [
        ...columns.map((column) => formatCsvValue(row[column])),
        dataAsOf ? dataAsOf.toISOString() : '',
      ]);
      const csv = toCsv(header, csvRows);

      const key = `${tenantId}/${exportId}.csv`;
      const { uri } = await this.storage.upload(key, csv, 'text/csv');

      await withTenantConnection(this.dataSource, tenantId, (manager) =>
        manager.update(
          AnalyticsExport,
          { id: exportId },
          {
            status: AnalyticsExportStatus.COMPLETED,
            fileUri: uri,
            rowCount: rows.length,
            completedAt: new Date(),
          },
        ),
      );
      this.metrics.analyticsExportsTotal.inc({ result: 'completed' });
    } catch (err) {
      await withTenantConnection(this.dataSource, tenantId, (manager) =>
        manager.update(
          AnalyticsExport,
          { id: exportId },
          {
            status: AnalyticsExportStatus.FAILED,
            errorMessage: (err as Error).message,
            completedAt: new Date(),
          },
        ),
      );
      this.metrics.analyticsExportsTotal.inc({ result: 'failed' });
    }
  }
}

function formatCsvValue(value: unknown): string | number {
  if (value === null || value === undefined) {
    return '';
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  return String(value);
}

// Own copy of adherence-compliance-service's `asJsonbValue` (ADR-0039
// precedent) - see dashboard.service.ts's own copy for why this cast
// exists (TypeORM's `insert()` typing quirk for jsonb columns).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asJsonbValue(value: unknown): any {
  return value;
}
