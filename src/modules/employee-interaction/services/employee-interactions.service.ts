import { Injectable } from '@nestjs/common';
import { EmployeeInteractionsRepository } from '../repositories/employee-interactions.repository';
import { EmployeeInteraction } from '../entities/employee-interaction.entity';
import { CreateEmployeeInteractionInput } from '../dto/create-employee-interaction.input';
import { EmployeesService } from '../../employee/services/employees.service';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { AuditLogRepository } from '../../audit/repositories/audit-log.repository';
import { AuditActorType } from '../../audit/entities/audit-actor-type.enum';
import { EmployeeInteractionNotFoundError } from '../errors/employee-interaction-not-found.error';

@Injectable()
export class EmployeeInteractionsService {
  constructor(
    private readonly interactionsRepository: EmployeeInteractionsRepository,
    private readonly employeesService: EmployeesService,
    private readonly tenantContext: TenantContextService,
    private readonly auditLog: AuditLogRepository,
  ) {}

  async findForEmployee(employeeId: string): Promise<EmployeeInteraction[]> {
    return this.interactionsRepository.findForEmployee(employeeId);
  }

  async findById(id: string): Promise<EmployeeInteraction> {
    const interaction = await this.interactionsRepository.findByIdOrNull(id);
    if (!interaction) throw new EmployeeInteractionNotFoundError(id);
    return interaction;
  }

  async create(input: CreateEmployeeInteractionInput): Promise<EmployeeInteraction> {
    await this.employeesService.findById(input.employeeId);
    const tenantId = this.tenantContext.requireTenantId();
    const actorId = this.tenantContext.getStore()?.actorId ?? null;
    const interaction = await this.interactionsRepository.save({
      employeeId: input.employeeId,
      interactionType: input.interactionType,
      body: input.body,
      createdBy: actorId,
    } as EmployeeInteraction);
    await this.auditLog.record({
      tenantId,
      actorId,
      actorType: AuditActorType.USER,
      action: 'employee_interaction.created',
      resourceType: 'employee',
      resourceId: input.employeeId,
      beforeState: null,
      // Body text is intentionally not duplicated into the audit log's
      // afterState - the interaction row itself is the append-only record
      // of what was said; the audit log records that the action happened.
      afterState: { interactionId: interaction.id, interactionType: interaction.interactionType } as unknown as Record<
        string,
        unknown
      >,
      aiRationale: null,
    });
    return interaction;
  }

  /**
   * Only `body` is patchable (`1700000028000` grants UPDATE, but
   * `employeeId`/`interactionType`/`createdBy`/`createdAt` stay immutable by
   * convention here, not by DB grant - there's no column-level GRANT in
   * Postgres for "UPDATE this column but not that one" on a plain UPDATE
   * privilege, so this method is the enforcement point).
   */
  async update(id: string, body: string): Promise<EmployeeInteraction> {
    await this.findById(id);
    await this.interactionsRepository.updateBody(id, body);
    const after = await this.findById(id);
    await this.auditLog.record({
      tenantId: this.tenantContext.requireTenantId(),
      actorId: this.tenantContext.getStore()?.actorId ?? null,
      actorType: AuditActorType.USER,
      action: 'employee_interaction.updated',
      resourceType: 'employee_interaction',
      resourceId: after.id,
      // Body text intentionally not duplicated into the audit log - see
      // `create`'s own comment for why.
      beforeState: null,
      afterState: { interactionId: after.id } as unknown as Record<string, unknown>,
      aiRationale: null,
    });
    return after;
  }

  /** Hard delete - no soft-delete column exists on this table. */
  async delete(id: string): Promise<void> {
    const interaction = await this.findById(id);
    await this.interactionsRepository.remove(id);
    await this.auditLog.record({
      tenantId: this.tenantContext.requireTenantId(),
      actorId: this.tenantContext.getStore()?.actorId ?? null,
      actorType: AuditActorType.USER,
      action: 'employee_interaction.deleted',
      resourceType: 'employee_interaction',
      resourceId: interaction.id,
      beforeState: { interactionId: interaction.id, interactionType: interaction.interactionType } as unknown as Record<
        string,
        unknown
      >,
      afterState: null,
      aiRationale: null,
    });
  }
}
