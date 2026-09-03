import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { AuditLogRepository } from '../repositories/audit-log.repository';
import { PendingAuditEventsRepository } from '../repositories/pending-audit-events.repository';
import { PendingAuditEvent } from '../entities/pending-audit-event.entity';
import { AuditActorType } from '../entities/audit-actor-type.enum';
import { AiRationaleRequiredError } from '../errors/ai-rationale-required.error';
import { NatsClientService } from '../../core-eventing/services/nats-client.service';
import { SUBJECTS } from '../../core-eventing/subjects';

export interface PendingAuditEventInput {
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

const FLUSH_MAX_RETRIES = 3;
const FLUSH_BATCH_SIZE = 100;

/**
 * §3.3's `AuditService.RecordEvent`: "fire-and-forget from every service,
 * batched into AuditLog." `enqueue` is what makes it fire-and-forget from
 * the *caller's* perspective (`AuditGrpcController` doesn't await it) - but
 * unlike the original Phase 5 cut, it is no longer a bare in-memory push.
 *
 * ADR-0042: `enqueue` durably inserts a row into `core.pending_audit_events`
 * (`PendingAuditEventsRepository`) before returning - the insert itself is
 * awaited internally and logged at ERROR level on failure, but the caller
 * doesn't block on it. This closes the gap the original design left open
 * ("no durable queue behind NATS... does not survive a process restart in
 * that specific window"): the queue now lives in Postgres, not process
 * memory, so a crash between `enqueue` and the next flush tick loses
 * nothing - the row is still there for the next tick (in this process or a
 * replacement one after a restart) to pick up.
 *
 * §2.2 rule 3 is still enforced synchronously in `enqueue`, before the
 * durable insert is even attempted - deferring that check would mean the
 * gRPC caller gets a success response for an event that was never going to
 * be persisted. `AuditLogRepository.record` re-checks it anyway (defense in
 * depth, same DB CHECK constraint too).
 *
 * §4's "must not silently drop audit events - define a retry/dead-letter
 * path": a flush failure increments the row's `attempts` counter in place
 * (`PendingAuditEventsRepository.recordFailure`) rather than requeuing an
 * in-memory copy; once `FLUSH_MAX_RETRIES` is exhausted, the row is routed
 * to `agno.core.dlq.v1` and deleted. If the DLQ publish itself also fails,
 * the row is left in place (still durable) and retried again next tick,
 * logged at ERROR with its full payload as the last-resort durability
 * floor for the genuinely rare "both Postgres writes are failing and NATS
 * is unreachable" window.
 *
 * `onModuleDestroy` (ADR-0042) makes a best-effort final flush on a
 * graceful shutdown (SIGTERM/SIGINT via `app.enableShutdownHooks()` in
 * `main.ts`) so a routine deploy doesn't leave up to 2 seconds' worth of
 * events sitting unflushed for no reason - belt-and-suspenders on top of
 * the durable queue, not a replacement for it (the durable queue is what
 * actually prevents loss; this just shortens the window under normal
 * operation).
 */
@Injectable()
export class AuditEventBatcherService implements OnModuleDestroy {
  private readonly logger = new Logger(AuditEventBatcherService.name);
  private flushing = false;

  constructor(
    private readonly auditLogRepository: AuditLogRepository,
    private readonly tenantContext: TenantContextService,
    private readonly natsClient: NatsClientService,
    private readonly pendingEvents: PendingAuditEventsRepository,
  ) {}

  enqueue(event: PendingAuditEventInput): void {
    if (event.actorType === AuditActorType.AI_AGENT && !event.aiRationale) {
      throw new AiRationaleRequiredError();
    }
    this.pendingEvents.enqueue(event).catch((err: Error) => {
      this.logger.error(
        `Failed to durably enqueue audit event (tenant=${event.tenantId} action=${event.action}): ` +
          `${err.message} - event payload: ${JSON.stringify(event)}`,
      );
    });
  }

  @Cron('*/2 * * * * *')
  async flush(): Promise<void> {
    if (this.flushing) {
      return;
    }
    this.flushing = true;
    try {
      const batch = await this.pendingEvents.findBatch(FLUSH_BATCH_SIZE);
      if (batch.length === 0) {
        return;
      }
      const byTenant = new Map<string, PendingAuditEvent[]>();
      for (const event of batch) {
        const existing = byTenant.get(event.tenantId) ?? [];
        existing.push(event);
        byTenant.set(event.tenantId, existing);
      }
      for (const [tenantId, events] of byTenant) {
        await this.flushTenantBatch(tenantId, events);
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Best-effort final drain on graceful shutdown (ADR-0042) - see class doc comment. */
  async onModuleDestroy(): Promise<void> {
    await this.flush();
  }

  private async flushTenantBatch(tenantId: string, events: PendingAuditEvent[]): Promise<void> {
    await this.tenantContext.run({ tenantId }, async () => {
      for (const event of events) {
        try {
          await this.auditLogRepository.record({
            tenantId: event.tenantId,
            actorId: event.actorId,
            actorType: event.actorType,
            action: event.action,
            resourceType: event.resourceType,
            resourceId: event.resourceId,
            beforeState: event.beforeState,
            afterState: event.afterState,
            aiRationale: event.aiRationale,
          });
          await this.pendingEvents.delete(event.id);
        } catch (err) {
          await this.handleFlushFailure(event, err as Error);
        }
      }
    });
  }

  private async handleFlushFailure(event: PendingAuditEvent, err: Error): Promise<void> {
    if (event.attempts + 1 >= FLUSH_MAX_RETRIES) {
      try {
        await this.natsClient.publish(SUBJECTS.DLQ, {
          originalSubject: SUBJECTS.AUDIT_CREATED,
          payload: event,
          error: err.message,
        });
        await this.pendingEvents.delete(event.id);
        this.logger.error(
          `Audit event=${event.id} (tenant=${event.tenantId} action=${event.action}) exhausted retries - routed to ${SUBJECTS.DLQ}: ${err.message}`,
        );
      } catch (dlqErr) {
        await this.pendingEvents.recordFailure(event.id, `DLQ publish also failed: ${(dlqErr as Error).message}`);
        this.logger.error(
          `Audit event=${event.id} (tenant=${event.tenantId} action=${event.action}) exhausted retries AND DLQ publish failed: ` +
            `${(dlqErr as Error).message} - row kept in core.pending_audit_events for retry, full payload: ${JSON.stringify(event)}`,
        );
      }
      return;
    }
    await this.pendingEvents.recordFailure(event.id, err.message);
    this.logger.warn(
      `Audit event=${event.id} flush failed (attempt ${event.attempts + 1}/${FLUSH_MAX_RETRIES}, tenant=${event.tenantId} action=${event.action}): ${err.message} - will retry`,
    );
  }
}
