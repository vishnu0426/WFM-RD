import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { withTenantTransaction } from '../../../common/tenant/with-tenant-transaction';
import { PendingAuditEvent } from '../entities/pending-audit-event.entity';
import { AuditActorType } from '../entities/audit-actor-type.enum';

/** Same escape-hatch shape as `CoreOutboxEventsRepository` (ADR-0007/ADR-0039) - the flush tick polls across every tenant, not one. */
const SYSTEM_BATCH_CONTEXT_TENANT_ID = '00000000-0000-0000-0000-000000000000';

export interface DurableAuditEventInput {
  tenantId: string;
  actorId: string | null;
  actorType: AuditActorType;
  action: string;
  resourceType: string;
  resourceId: string | null;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  aiRationale: Record<string, unknown> | null;
}

/** ADR-0042: the durable-queue counterpart to `CoreOutboxEventsRepository` - same cross-tenant batch-read shape, one step earlier in the audit pipeline. */
@Injectable()
export class PendingAuditEventsRepository {
  constructor(private readonly dataSource: DataSource) {}

  async enqueue(event: DurableAuditEventInput): Promise<void> {
    await withTenantTransaction(this.dataSource, { tenantId: event.tenantId, isPlatformAdmin: false }, (manager) =>
      manager.getRepository(PendingAuditEvent).insert({
        id: uuidv4(),
        tenantId: event.tenantId,
        actorId: event.actorId,
        actorType: event.actorType,
        action: event.action,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        beforeState: event.beforeState as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        afterState: event.afterState as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        aiRationale: event.aiRationale as any,
        createdAt: new Date(),
        attempts: 0,
        lastError: null,
      }),
    );
  }

  /** Cross-tenant by design - the flush tick has no single tenant to scope to. */
  async findBatch(limit: number): Promise<PendingAuditEvent[]> {
    return withTenantTransaction(
      this.dataSource,
      { tenantId: SYSTEM_BATCH_CONTEXT_TENANT_ID, isPlatformAdmin: true },
      (manager) =>
        manager
          .getRepository(PendingAuditEvent)
          .createQueryBuilder('e')
          .orderBy('e.created_at', 'ASC')
          .limit(limit)
          .getMany(),
    );
  }

  /** Phase 7 (ADR-0050): backs the `core_pending_audit_events` gauge `MetricsController` exposes - every row in this table is inherently "pending" (processed rows are deleted, not marked). */
  async count(): Promise<number> {
    return withTenantTransaction(
      this.dataSource,
      { tenantId: SYSTEM_BATCH_CONTEXT_TENANT_ID, isPlatformAdmin: true },
      (manager) => manager.getRepository(PendingAuditEvent).count(),
    );
  }

  async delete(id: string): Promise<void> {
    await withTenantTransaction(
      this.dataSource,
      { tenantId: SYSTEM_BATCH_CONTEXT_TENANT_ID, isPlatformAdmin: true },
      (manager) => manager.getRepository(PendingAuditEvent).delete({ id }),
    );
  }

  async recordFailure(id: string, error: string): Promise<void> {
    await withTenantTransaction(
      this.dataSource,
      { tenantId: SYSTEM_BATCH_CONTEXT_TENANT_ID, isPlatformAdmin: true },
      (manager) =>
        manager.query('UPDATE core.pending_audit_events SET attempts = attempts + 1, last_error = $1 WHERE id = $2', [
          error,
          id,
        ]),
    );
  }
}
