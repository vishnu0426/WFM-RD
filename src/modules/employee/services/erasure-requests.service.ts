import { Injectable } from '@nestjs/common';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { ErasureRequestsRepository } from '../repositories/erasure-requests.repository';
import { ErasureRequest } from '../entities/erasure-request.entity';
import { ErasureRequestStatus } from '../entities/erasure-request-status.enum';
import { ErasureRequestNotFoundError } from '../errors/erasure-request-not-found.error';
import { ErasureRequestInvalidTransitionError } from '../errors/erasure-request-invalid-transition.error';
import { ErasureRequestActorRequiredError } from '../errors/erasure-request-actor-required.error';
import { EmployeesService } from './employees.service';
import { AuditLogRepository } from '../../audit/repositories/audit-log.repository';
import { AuditActorType } from '../../audit/entities/audit-actor-type.enum';

/**
 * §2.4/§8: the request lifecycle plus the Phase 8 anonymization action
 * itself. `pending -> approved|rejected`, `approved -> completed|rejected`
 * only - deliberately no `pending -> completed` shortcut, since §2.4's
 * "legal sufficiency of the workflow is a legal/compliance decision this
 * codebase does not get to make" implies a request must be explicitly
 * approved by someone before the (irreversible) anonymization runs.
 *
 * GAP-06 fix (enterprise readiness audit, 2026-08-18): `create`/`approve`/
 * `reject` now record an `audit_log` entry - audited here at the service
 * layer, not in `ErasureRequestResolver`/`ErasureRequestsController`
 * individually, since both surfaces call these same three methods and a
 * per-caller retrofit would risk covering one but not the other.
 * `complete` already records its own entry inside
 * `ErasureRequestsRepository.completeAndAnonymize` (in the same transaction
 * as the anonymization write itself) - not duplicated here.
 */
@Injectable()
export class ErasureRequestsService {
  constructor(
    private readonly erasureRequestsRepository: ErasureRequestsRepository,
    private readonly employeesService: EmployeesService,
    private readonly tenantContext: TenantContextService,
    private readonly auditLog: AuditLogRepository,
  ) {}

  async findById(id: string): Promise<ErasureRequest> {
    const request = await this.erasureRequestsRepository.findOne({ where: { id } as never });
    if (!request) {
      throw new ErasureRequestNotFoundError(id);
    }
    return request;
  }

  async findByEmployee(employeeId: string): Promise<ErasureRequest[]> {
    return this.erasureRequestsRepository.findByEmployee(employeeId);
  }

  async create(employeeId: string, legalBasis: string): Promise<ErasureRequest> {
    await this.employeesService.findById(employeeId);
    const requestedBy = this.tenantContext.getStore()?.actorId;
    if (!requestedBy) {
      throw new ErasureRequestActorRequiredError();
    }
    const request = await this.erasureRequestsRepository.create({ employeeId, requestedBy, legalBasis });
    await this.audit('erasure_request.created', request.id, null, request);
    return request;
  }

  async approve(id: string): Promise<ErasureRequest> {
    const before = await this.findById(id);
    if (before.status !== ErasureRequestStatus.PENDING) {
      throw new ErasureRequestInvalidTransitionError(id, before.status, ErasureRequestStatus.APPROVED);
    }
    const request = await this.erasureRequestsRepository.setStatus(id, ErasureRequestStatus.APPROVED);
    await this.audit('erasure_request.approved', id, before, request);
    return request;
  }

  async reject(id: string): Promise<ErasureRequest> {
    const before = await this.findById(id);
    if (before.status !== ErasureRequestStatus.PENDING && before.status !== ErasureRequestStatus.APPROVED) {
      throw new ErasureRequestInvalidTransitionError(id, before.status, ErasureRequestStatus.REJECTED);
    }
    const request = await this.erasureRequestsRepository.setStatus(id, ErasureRequestStatus.REJECTED);
    await this.audit('erasure_request.rejected', id, before, request);
    return request;
  }

  async complete(id: string): Promise<ErasureRequest> {
    const request = await this.findById(id);
    if (request.status !== ErasureRequestStatus.APPROVED) {
      throw new ErasureRequestInvalidTransitionError(id, request.status, ErasureRequestStatus.COMPLETED);
    }
    const actorId = this.tenantContext.getStore()?.actorId ?? null;
    return this.erasureRequestsRepository.completeAndAnonymize(request, actorId);
  }

  private async audit(
    action: string,
    resourceId: string,
    beforeState: ErasureRequest | null,
    afterState: ErasureRequest | null,
  ): Promise<void> {
    await this.auditLog.record({
      tenantId: this.tenantContext.requireTenantId(),
      actorId: this.tenantContext.getStore()?.actorId ?? null,
      actorType: AuditActorType.USER,
      action,
      resourceType: 'erasure_request',
      resourceId,
      beforeState: beforeState as unknown as Record<string, unknown> | null,
      afterState: afterState as unknown as Record<string, unknown> | null,
      aiRationale: null,
    });
  }
}
