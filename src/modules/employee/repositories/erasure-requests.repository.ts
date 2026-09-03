import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantScopedRepository } from '../../../common/tenant/tenant-scoped.repository';
import { withTenantTransaction } from '../../../common/tenant/with-tenant-transaction';
import { ErasureRequest } from '../entities/erasure-request.entity';
import { ErasureRequestStatus } from '../entities/erasure-request-status.enum';
import { Employee } from '../entities/employee.entity';
import { AuditLog } from '../../audit/entities/audit-log.entity';
import { AuditActorType } from '../../audit/entities/audit-actor-type.enum';
import { OutboxEventsRepository } from '../../eventing/repositories/outbox-events.repository';
import { SUBJECTS } from '../../eventing/subjects';

/**
 * Phase 1 scope is the request lifecycle only (§2.4) - the anonymization
 * workflow that runs when a request reaches `completed` is Phase 8.
 */
@Injectable()
export class ErasureRequestsRepository extends TenantScopedRepository<ErasureRequest> {
  constructor(dataSource: DataSource, tenantContext: TenantContextService) {
    super(dataSource, ErasureRequest, tenantContext);
  }

  async create(input: { employeeId: string; requestedBy: string; legalBasis: string }): Promise<ErasureRequest> {
    return this.save({
      id: uuidv4(),
      employeeId: input.employeeId,
      requestedBy: input.requestedBy,
      legalBasis: input.legalBasis,
      status: ErasureRequestStatus.PENDING,
      completedAt: null,
    } as ErasureRequest);
  }

  async findByEmployee(employeeId: string): Promise<ErasureRequest[]> {
    return this.find({ where: { employeeId } as never });
  }

  async setStatus(id: string, status: ErasureRequestStatus): Promise<ErasureRequest> {
    await this.update({ id } as never, { status } as never);
    return this.findOne({ where: { id } as never }).then((row) => row!);
  }

  /**
   * The Phase 8 anonymization action itself (§2.4). Everything commits in
   * one transaction - the `Employee`/`EmployeeHistory` scrub, the
   * `ErasureRequest` status flip, the `AuditLog` entry, and the outbox
   * event - or none of it does; a completed-but-unaudited erasure (or vice
   * versa) is exactly the kind of half-applied state GDPR tooling can't
   * afford.
   *
   * Field-by-field rule (ADR-0022): `employeeNumber` is replaced with a
   * random `ERASED-<8 hex>` placeholder on the live `Employee` row and on
   * every `EmployeeHistory` row for that employee (append-only history
   * would otherwise keep leaking the original value forever); `userId` is
   * set to null, severing the link to the (out-of-module-scope) `core.users`
   * identity record. Every other column - org_unit_id, employment_type,
   * contract_hours_per_week, hire/termination dates, cost_center,
   * manager_employee_id, status - is left untouched: none of it is PII, and
   * §2.4 requires preserving aggregate/statistical shape for historical
   * reporting, not blanket deletion.
   *
   * `AuditLog.beforeState`/`afterState` deliberately hold only metadata
   * (which fields were touched, how many history rows), never the actual
   * pre-erasure `employeeNumber` - logging the real value into an
   * append-only, cross-tenant-readable-by-platform-admin audit table would
   * silently defeat the erasure it's supposed to be recording (§2.4: "not
   * the erased PII itself").
   */
  async completeAndAnonymize(request: ErasureRequest, actorId: string | null): Promise<ErasureRequest> {
    const tenantId = this.tenantContext.requireTenantId();
    const isPlatformAdmin = this.tenantContext.isPlatformAdmin();
    const anonymizedEmployeeNumber = `ERASED-${uuidv4().slice(0, 8)}`;

    return withTenantTransaction(this.dataSource, { tenantId, isPlatformAdmin }, async (manager) => {
      const employeeRepo = manager.getRepository(Employee);
      const employee = await employeeRepo.findOneOrFail({ where: { tenantId, id: request.employeeId } as never });

      await employeeRepo.update(
        { tenantId, id: request.employeeId } as never,
        {
          employeeNumber: anonymizedEmployeeNumber,
          userId: null,
        } as never,
      );

      const [{ count: historyRowsAnonymized }] = await manager.query(
        `SELECT count(*)::int AS count FROM org.employee_history WHERE tenant_id = $1 AND employee_id = $2`,
        [tenantId, request.employeeId],
      );
      await manager.query(
        `UPDATE org.employee_history SET employee_number = $1 WHERE tenant_id = $2 AND employee_id = $3`,
        [anonymizedEmployeeNumber, tenantId, request.employeeId],
      );

      const completed = await manager.getRepository(ErasureRequest).save({
        ...request,
        status: ErasureRequestStatus.COMPLETED,
        completedAt: new Date(),
      });

      await manager.getRepository(AuditLog).save({
        id: uuidv4(),
        createdAt: new Date(),
        tenantId,
        actorId,
        actorType: AuditActorType.USER,
        action: 'employee.erasure.completed',
        resourceType: 'Employee',
        resourceId: request.employeeId,
        beforeState: { erasureRequestId: request.id, legalBasis: request.legalBasis },
        afterState: { fieldsAnonymized: ['employeeNumber', 'userId'], historyRowsAnonymized },
        aiRationale: null,
      });

      await OutboxEventsRepository.insertWithinTransaction(manager, tenantId, SUBJECTS.EMPLOYEE_CHANGED, {
        employeeId: request.employeeId,
        tenantId,
        eventType: 'erased',
        orgUnitId: employee.orgUnitId,
        updatedAt: new Date().toISOString(),
      });

      return completed;
    });
  }
}
