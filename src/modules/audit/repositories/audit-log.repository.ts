import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantMismatchError } from '../../../common/tenant/tenant-context.errors';
import { withTenantTransaction } from '../../../common/tenant/with-tenant-transaction';
import { AuditLog } from '../entities/audit-log.entity';
import { AuditActorType } from '../entities/audit-actor-type.enum';
import { AiRationaleRequiredError } from '../errors/ai-rationale-required.error';
import { CoreOutboxEventsRepository } from '../../core-eventing/repositories/outbox-events.repository';
import { SUBJECTS, AuditEventPayload } from '../../core-eventing/subjects';

type RecordAuditLogInput = Omit<AuditLog, 'id' | 'createdAt'>;

/**
 * Deliberately not a TenantScopedRepository subclass: this class exposes no
 * update()/delete() method at all (not even a guarded one), matching the
 * GRANT-level restriction on agno_app (§2.2 rule 2) and the DB-level
 * ai_rationale CHECK constraint (§2.2 rule 3) from the Phase 1 migration.
 *
 * Phase 5 (ADR-0039): `record` is the single write path for `audit_log` -
 * every caller (`AuditEventBatcherService`'s flush, `PolicyManagementService`,
 * `RoleManagementController`, ...) goes through here, so this is also the
 * one place that needs to write the transactional outbox row
 * (`AuditEvent`, §4) - never a separate, unguarded insert elsewhere that
 * could drift out of sync with what actually landed in `audit_log`.
 */
@Injectable()
export class AuditLogRepository {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
  ) {}

  async record(entry: RecordAuditLogInput): Promise<AuditLog> {
    const tenantId = this.tenantContext.requireTenantId();
    if (entry.tenantId !== tenantId) {
      throw new TenantMismatchError(tenantId, entry.tenantId);
    }
    // §2.2 rule 3, enforced here (app layer) in addition to the DB CHECK
    // constraint: reject before the write ever reaches the transaction.
    if (entry.actorType === AuditActorType.AI_AGENT && !entry.aiRationale) {
      throw new AiRationaleRequiredError();
    }
    // id/createdAt are generated client-side rather than relied upon via
    // Postgres RETURNING - keeps the immediately-returned entity's identity
    // deterministic regardless of driver/version RETURNING behavior.
    const toInsert: AuditLog = { ...(entry as AuditLog), id: uuidv4(), createdAt: new Date() };
    return withTenantTransaction(
      this.dataSource,
      { tenantId, isPlatformAdmin: this.tenantContext.isPlatformAdmin() },
      async (manager) => {
        const saved = await manager.getRepository(AuditLog).save(toInsert);
        const payload: AuditEventPayload = {
          auditLogId: saved.id,
          tenantId: saved.tenantId,
          actorId: saved.actorId,
          actorType: saved.actorType,
          action: saved.action,
          resourceType: saved.resourceType,
          resourceId: saved.resourceId,
          createdAt: saved.createdAt.toISOString(),
        };
        await CoreOutboxEventsRepository.insertWithinTransaction(
          manager,
          tenantId,
          SUBJECTS.AUDIT_CREATED,
          payload as unknown as Record<string, unknown>,
        );
        return saved;
      },
    );
  }

  /**
   * §3.2's `GET /v1/audit-log` - "Paginated, filterable by
   * actor_type/resource_type/date range." Cursor-based on `created_at`
   * (`before`, exclusive) rather than `OFFSET` - `audit_log` is this
   * module's highest-write-volume, monthly-partitioned table (ADR-0005),
   * and `OFFSET` pagination degrades linearly with how deep a caller pages,
   * exactly the kind of table where that matters.
   */
  async findByTenant(
    tenantId: string,
    options: {
      resourceType?: string;
      resourceId?: string;
      actorType?: AuditActorType;
      startDate?: Date;
      endDate?: Date;
      before?: Date;
      limit?: number;
    } = {},
  ): Promise<AuditLog[]> {
    return withTenantTransaction(this.dataSource, { tenantId }, (manager) => {
      const qb = manager
        .getRepository(AuditLog)
        .createQueryBuilder('audit_log')
        .where('audit_log.tenant_id = :tenantId', { tenantId })
        .orderBy('audit_log.created_at', 'DESC')
        .take(Math.min(options.limit ?? 50, 200));
      if (options.resourceType) {
        qb.andWhere('audit_log.resource_type = :resourceType', { resourceType: options.resourceType });
      }
      if (options.resourceId) {
        qb.andWhere('audit_log.resource_id = :resourceId', { resourceId: options.resourceId });
      }
      if (options.actorType) {
        qb.andWhere('audit_log.actor_type = :actorType', { actorType: options.actorType });
      }
      if (options.startDate) {
        qb.andWhere('audit_log.created_at >= :startDate', { startDate: options.startDate });
      }
      if (options.endDate) {
        qb.andWhere('audit_log.created_at <= :endDate', { endDate: options.endDate });
      }
      if (options.before) {
        qb.andWhere('audit_log.created_at < :before', { before: options.before });
      }
      return qb.getMany();
    });
  }
}
