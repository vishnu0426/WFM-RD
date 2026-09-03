import { Injectable } from '@nestjs/common';
import { EmployeeSkillsRepository } from '../repositories/employee-skills.repository';
import { SkillsService } from './skills.service';
import { EmployeeSkill } from '../entities/employee-skill.entity';
import { UpdateEmployeeSkillsInput } from '../dto/update-employee-skills.input';
import { EmployeesService } from '../../employee/services/employees.service';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { AuditLogRepository } from '../../audit/repositories/audit-log.repository';
import { AuditActorType } from '../../audit/entities/audit-actor-type.enum';

/**
 * GAP-06 fix (enterprise readiness audit, 2026-08-18): `updateForEmployee`
 * now records one `audit_log` entry per call (not per individual skill
 * assignment - the mutation is one bulk upsert from the caller's point of
 * view, same "one action, one entry" granularity `PolicyManagementController`
 * uses for its own multi-field writes).
 */
@Injectable()
export class EmployeeSkillsService {
  constructor(
    private readonly employeeSkillsRepository: EmployeeSkillsRepository,
    private readonly skillsService: SkillsService,
    private readonly employeesService: EmployeesService,
    private readonly tenantContext: TenantContextService,
    private readonly auditLog: AuditLogRepository,
  ) {}

  async findForEmployee(employeeId: string): Promise<EmployeeSkill[]> {
    return this.employeeSkillsRepository.findForEmployee(employeeId);
  }

  async findExpiring(withinDays: number, pagination: { limit: number; offset: number }): Promise<EmployeeSkill[]> {
    return this.employeeSkillsRepository.findExpiringWithin(withinDays, pagination);
  }

  /**
   * §3.1's `updateEmployeeSkills` - bulk upsert. Each assignment's
   * `skillId` is validated via `SkillsService.findById` before the write
   * (a clean `SkillNotFoundError` instead of a raw FK violation, same
   * pattern as `EmployeesService.create`/`transfer` - ADR-0016).
   * `expiryDate` is left for `org.fn_employee_skill_set_expiry` (Phase 1
   * trigger) to derive; never set directly here.
   */
  async updateForEmployee(input: UpdateEmployeeSkillsInput): Promise<EmployeeSkill[]> {
    await this.employeesService.findById(input.employeeId);
    const before = await this.findForEmployee(input.employeeId);
    for (const assignment of input.skills) {
      await this.skillsService.findById(assignment.skillId);
      const existing = await this.employeeSkillsRepository.findOneFor(input.employeeId, assignment.skillId);
      if (existing) {
        await this.employeeSkillsRepository.update(
          { employeeId: input.employeeId, skillId: assignment.skillId } as never,
          { proficiencyLevel: assignment.proficiencyLevel, certifiedDate: assignment.certifiedDate ?? null } as never,
        );
      } else {
        await this.employeeSkillsRepository.save({
          employeeId: input.employeeId,
          skillId: assignment.skillId,
          proficiencyLevel: assignment.proficiencyLevel,
          certifiedDate: assignment.certifiedDate ?? null,
          lastScheduledOnSkillAt: null,
        } as EmployeeSkill);
      }
    }
    const after = await this.findForEmployee(input.employeeId);
    await this.auditLog.record({
      tenantId: this.tenantContext.requireTenantId(),
      actorId: this.tenantContext.getStore()?.actorId ?? null,
      actorType: AuditActorType.USER,
      action: 'employee.skills.updated',
      resourceType: 'employee',
      resourceId: input.employeeId,
      beforeState: { skills: before } as unknown as Record<string, unknown>,
      afterState: { skills: after } as unknown as Record<string, unknown>,
      aiRationale: null,
    });
    return after;
  }
}
