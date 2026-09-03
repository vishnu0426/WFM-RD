import { Injectable } from '@nestjs/common';
import { EmployeeGroupsRepository } from '../repositories/employee-groups.repository';
import { EmployeeGroupMembersRepository } from '../repositories/employee-group-members.repository';
import { EmployeeGroup } from '../entities/employee-group.entity';
import { EmployeeGroupMember } from '../entities/employee-group-member.entity';
import { CreateEmployeeGroupInput } from '../dto/create-employee-group.input';
import { UpdateEmployeeGroupInput } from '../dto/update-employee-group.input';
import { EmployeeGroupFilterInput } from '../dto/employee-group-filter.input';
import { EmployeeGroupStatus } from '../entities/employee-group-status.enum';
import { EmployeeGroupNotFoundError } from '../errors/employee-group-not-found.error';
import { EmployeesService } from '../../employee/services/employees.service';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { AuditLogRepository } from '../../audit/repositories/audit-log.repository';
import { AuditActorType } from '../../audit/entities/audit-actor-type.enum';

@Injectable()
export class EmployeeGroupsService {
  constructor(
    private readonly groupsRepository: EmployeeGroupsRepository,
    private readonly membersRepository: EmployeeGroupMembersRepository,
    private readonly employeesService: EmployeesService,
    private readonly tenantContext: TenantContextService,
    private readonly auditLog: AuditLogRepository,
  ) {}

  async findAll(filter: EmployeeGroupFilterInput = {}): Promise<EmployeeGroup[]> {
    return this.groupsRepository.findAll({
      organizationId: filter.organizationId,
      parentGroupId: filter.parentGroupId,
      status: filter.status,
      rootOnly: filter.rootOnly,
    });
  }

  async findById(id: string): Promise<EmployeeGroup> {
    const group = await this.groupsRepository.findByIdOrNull(id);
    if (!group) throw new EmployeeGroupNotFoundError(id);
    return group;
  }

  async create(input: CreateEmployeeGroupInput): Promise<EmployeeGroup> {
    const tenantId = this.tenantContext.requireTenantId();
    const group = await this.groupsRepository.save({
      name: input.name,
      description: input.description ?? null,
      organizationId: input.organizationId ?? null,
      parentGroupId: input.parentGroupId ?? null,
      status: input.status ?? EmployeeGroupStatus.ACTIVE,
    } as EmployeeGroup);
    await this.auditLog.record({
      tenantId,
      actorId: this.tenantContext.getStore()?.actorId ?? null,
      actorType: AuditActorType.USER,
      action: 'employee_group.created',
      resourceType: 'employee_group',
      resourceId: group.id,
      beforeState: null,
      afterState: this.snapshot(group),
      aiRationale: null,
    });
    return group;
  }

  async update(input: UpdateEmployeeGroupInput): Promise<EmployeeGroup> {
    const before = await this.findById(input.id);
    await this.groupsRepository.update(
      { id: input.id } as never,
      {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.organizationId !== undefined ? { organizationId: input.organizationId } : {}),
        ...(input.parentGroupId !== undefined ? { parentGroupId: input.parentGroupId } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      } as never,
    );
    const after = await this.findById(input.id);
    await this.auditLog.record({
      tenantId: this.tenantContext.requireTenantId(),
      actorId: this.tenantContext.getStore()?.actorId ?? null,
      actorType: AuditActorType.USER,
      action: 'employee_group.updated',
      resourceType: 'employee_group',
      resourceId: after.id,
      beforeState: this.snapshot(before),
      afterState: this.snapshot(after),
      aiRationale: null,
    });
    return after;
  }

  private snapshot(group: EmployeeGroup): Record<string, unknown> {
    return {
      name: group.name,
      description: group.description,
      organizationId: group.organizationId,
      parentGroupId: group.parentGroupId,
      status: group.status,
    };
  }

  async delete(id: string): Promise<void> {
    const group = await this.findById(id);
    // Membership rows cascade at the DB level (ON DELETE CASCADE) - no need
    // to remove them here first.
    await this.groupsRepository.delete({ id } as never);
    await this.auditLog.record({
      tenantId: this.tenantContext.requireTenantId(),
      actorId: this.tenantContext.getStore()?.actorId ?? null,
      actorType: AuditActorType.USER,
      action: 'employee_group.deleted',
      resourceType: 'employee_group',
      resourceId: group.id,
      beforeState: this.snapshot(group),
      afterState: null,
      aiRationale: null,
    });
  }

  async listMembers(groupId: string): Promise<EmployeeGroupMember[]> {
    await this.findById(groupId);
    return this.membersRepository.findForGroup(groupId);
  }

  async addMember(groupId: string, employeeId: string): Promise<EmployeeGroupMember> {
    await this.findById(groupId);
    await this.employeesService.findById(employeeId);
    if (await this.membersRepository.exists(groupId, employeeId)) {
      return (await this.membersRepository.findForGroup(groupId)).find((m) => m.employeeId === employeeId)!;
    }
    const member = await this.membersRepository.save({ groupId, employeeId } as EmployeeGroupMember);
    await this.auditLog.record({
      tenantId: this.tenantContext.requireTenantId(),
      actorId: this.tenantContext.getStore()?.actorId ?? null,
      actorType: AuditActorType.USER,
      action: 'employee_group.member_added',
      resourceType: 'employee_group',
      resourceId: groupId,
      beforeState: null,
      afterState: { employeeId } as unknown as Record<string, unknown>,
      aiRationale: null,
    });
    return member;
  }

  async removeMember(groupId: string, employeeId: string): Promise<void> {
    await this.findById(groupId);
    await this.membersRepository.remove(groupId, employeeId);
    await this.auditLog.record({
      tenantId: this.tenantContext.requireTenantId(),
      actorId: this.tenantContext.getStore()?.actorId ?? null,
      actorType: AuditActorType.USER,
      action: 'employee_group.member_removed',
      resourceType: 'employee_group',
      resourceId: groupId,
      beforeState: { employeeId } as unknown as Record<string, unknown>,
      afterState: null,
      aiRationale: null,
    });
  }

  /** Consulted by WorkRulesService to resolve group-based rule assignments for a given employee. */
  async findGroupIdsForEmployee(employeeId: string): Promise<string[]> {
    return (await this.membersRepository.findForEmployee(employeeId)).map((m) => m.groupId);
  }
}
