import { Injectable } from '@nestjs/common';
import { WorkRulesRepository } from '../repositories/work-rules.repository';
import { WorkRuleAssignmentsRepository } from '../repositories/work-rule-assignments.repository';
import { WorkRule } from '../entities/work-rule.entity';
import { WorkRuleAssignment } from '../entities/work-rule-assignment.entity';
import { AssigneeType } from '../entities/assignee-type.enum';
import { CreateWorkRuleInput } from '../dto/create-work-rule.input';
import { UpdateWorkRuleInput } from '../dto/update-work-rule.input';
import { WorkRuleNotFoundError } from '../errors/work-rule-not-found.error';
import { EmployeesService } from '../../employee/services/employees.service';
import { EmployeeGroupsService } from '../../employee-group/services/employee-groups.service';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { AuditLogRepository } from '../../audit/repositories/audit-log.repository';
import { AuditActorType } from '../../audit/entities/audit-actor-type.enum';

@Injectable()
export class WorkRulesService {
  constructor(
    private readonly workRulesRepository: WorkRulesRepository,
    private readonly assignmentsRepository: WorkRuleAssignmentsRepository,
    private readonly employeesService: EmployeesService,
    private readonly employeeGroupsService: EmployeeGroupsService,
    private readonly tenantContext: TenantContextService,
    private readonly auditLog: AuditLogRepository,
  ) {}

  async findAll(): Promise<WorkRule[]> {
    return this.workRulesRepository.findAll();
  }

  async findById(id: string): Promise<WorkRule> {
    const rule = await this.workRulesRepository.findByIdOrNull(id);
    if (!rule) throw new WorkRuleNotFoundError(id);
    return rule;
  }

  async create(input: CreateWorkRuleInput): Promise<WorkRule> {
    const tenantId = this.tenantContext.requireTenantId();
    const rule = await this.workRulesRepository.save({
      name: input.name,
      description: input.description ?? null,
      maxConsecutiveDays: input.maxConsecutiveDays ?? null,
      minRestHours: input.minRestHours != null ? String(input.minRestHours) : null,
      maxWeeklyHours: input.maxWeeklyHours != null ? String(input.maxWeeklyHours) : null,
      otEligible: input.otEligible ?? true,
      minPaidHours: input.minPaidHours != null ? String(input.minPaidHours) : null,
      maxOtPerDay: input.maxOtPerDay != null ? String(input.maxOtPerDay) : null,
      maxOtPerWeek: input.maxOtPerWeek != null ? String(input.maxOtPerWeek) : null,
      maxVtoPerDay: input.maxVtoPerDay != null ? String(input.maxVtoPerDay) : null,
      maxVtoPerWeek: input.maxVtoPerWeek != null ? String(input.maxVtoPerWeek) : null,
      requiredPayPeriodHours: input.requiredPayPeriodHours != null ? String(input.requiredPayPeriodHours) : null,
      effectiveFrom: input.effectiveFrom ?? null,
      effectiveTo: input.effectiveTo ?? null,
    } as WorkRule);
    await this.auditLog.record({
      tenantId,
      actorId: this.tenantContext.getStore()?.actorId ?? null,
      actorType: AuditActorType.USER,
      action: 'work_rule.created',
      resourceType: 'work_rule',
      resourceId: rule.id,
      beforeState: null,
      afterState: rule as unknown as Record<string, unknown>,
      aiRationale: null,
    });
    return rule;
  }

  async update(input: UpdateWorkRuleInput): Promise<WorkRule> {
    const before = await this.findById(input.id);
    const partial: Partial<WorkRule> = {};
    if (input.name !== undefined) partial.name = input.name;
    if (input.description !== undefined) partial.description = input.description;
    if (input.maxConsecutiveDays !== undefined) partial.maxConsecutiveDays = input.maxConsecutiveDays;
    if (input.minRestHours !== undefined) partial.minRestHours = input.minRestHours != null ? String(input.minRestHours) : null;
    if (input.maxWeeklyHours !== undefined) partial.maxWeeklyHours = input.maxWeeklyHours != null ? String(input.maxWeeklyHours) : null;
    if (input.otEligible !== undefined) partial.otEligible = input.otEligible;
    if (input.minPaidHours !== undefined) partial.minPaidHours = input.minPaidHours != null ? String(input.minPaidHours) : null;
    if (input.maxOtPerDay !== undefined) partial.maxOtPerDay = input.maxOtPerDay != null ? String(input.maxOtPerDay) : null;
    if (input.maxOtPerWeek !== undefined) partial.maxOtPerWeek = input.maxOtPerWeek != null ? String(input.maxOtPerWeek) : null;
    if (input.maxVtoPerDay !== undefined) partial.maxVtoPerDay = input.maxVtoPerDay != null ? String(input.maxVtoPerDay) : null;
    if (input.maxVtoPerWeek !== undefined) partial.maxVtoPerWeek = input.maxVtoPerWeek != null ? String(input.maxVtoPerWeek) : null;
    if (input.requiredPayPeriodHours !== undefined)
      partial.requiredPayPeriodHours = input.requiredPayPeriodHours != null ? String(input.requiredPayPeriodHours) : null;
    if (input.effectiveFrom !== undefined) partial.effectiveFrom = input.effectiveFrom;
    if (input.effectiveTo !== undefined) partial.effectiveTo = input.effectiveTo;
    await this.workRulesRepository.update({ id: input.id } as never, partial as never);
    const after = await this.findById(input.id);
    await this.auditLog.record({
      tenantId: this.tenantContext.requireTenantId(),
      actorId: this.tenantContext.getStore()?.actorId ?? null,
      actorType: AuditActorType.USER,
      action: 'work_rule.updated',
      resourceType: 'work_rule',
      resourceId: after.id,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: after as unknown as Record<string, unknown>,
      aiRationale: null,
    });
    return after;
  }

  async delete(id: string): Promise<void> {
    const rule = await this.findById(id);
    await this.workRulesRepository.delete({ id } as never);
    await this.auditLog.record({
      tenantId: this.tenantContext.requireTenantId(),
      actorId: this.tenantContext.getStore()?.actorId ?? null,
      actorType: AuditActorType.USER,
      action: 'work_rule.deleted',
      resourceType: 'work_rule',
      resourceId: rule.id,
      beforeState: rule as unknown as Record<string, unknown>,
      afterState: null,
      aiRationale: null,
    });
  }

  async listAssignments(workRuleId: string): Promise<WorkRuleAssignment[]> {
    await this.findById(workRuleId);
    return this.assignmentsRepository.findForWorkRule(workRuleId);
  }

  /**
   * Validates the assignee actually exists before assigning - no DB-level FK
   * is possible for this polymorphic reference (migration's own doc comment).
   * Re-assigning an already-bound (workRuleId, assigneeType, assigneeId) —
   * the composite PK, unaffected by priority/dates — now updates its
   * priority/effective window instead of silently no-op'ing, since those
   * are exactly the fields a caller re-assigning would be trying to change.
   */
  async assign(
    workRuleId: string,
    assigneeType: AssigneeType,
    assigneeId: string,
    priority = 0,
    effectiveFrom: string | null = null,
    effectiveTo: string | null = null,
  ): Promise<WorkRuleAssignment> {
    await this.findById(workRuleId);
    if (assigneeType === AssigneeType.EMPLOYEE) {
      await this.employeesService.findById(assigneeId);
    } else {
      await this.employeeGroupsService.findById(assigneeId);
    }
    if (await this.assignmentsRepository.exists(workRuleId, assigneeType, assigneeId)) {
      await this.assignmentsRepository.update(
        { workRuleId, assigneeType, assigneeId } as never,
        { priority, effectiveFrom, effectiveTo } as never,
      );
      return (await this.assignmentsRepository.findForWorkRule(workRuleId)).find(
        (a) => a.assigneeType === assigneeType && a.assigneeId === assigneeId,
      )!;
    }
    const assignment = await this.assignmentsRepository.save({
      workRuleId,
      assigneeType,
      assigneeId,
      priority,
      effectiveFrom,
      effectiveTo,
    } as WorkRuleAssignment);
    await this.auditLog.record({
      tenantId: this.tenantContext.requireTenantId(),
      actorId: this.tenantContext.getStore()?.actorId ?? null,
      actorType: AuditActorType.USER,
      action: 'work_rule.assigned',
      resourceType: 'work_rule',
      resourceId: workRuleId,
      beforeState: null,
      afterState: { assigneeType, assigneeId } as unknown as Record<string, unknown>,
      aiRationale: null,
    });
    return assignment;
  }

  async unassign(workRuleId: string, assigneeType: AssigneeType, assigneeId: string): Promise<void> {
    await this.findById(workRuleId);
    await this.assignmentsRepository.remove(workRuleId, assigneeType, assigneeId);
    await this.auditLog.record({
      tenantId: this.tenantContext.requireTenantId(),
      actorId: this.tenantContext.getStore()?.actorId ?? null,
      actorType: AuditActorType.USER,
      action: 'work_rule.unassigned',
      resourceType: 'work_rule',
      resourceId: workRuleId,
      beforeState: { assigneeType, assigneeId } as unknown as Record<string, unknown>,
      afterState: null,
      aiRationale: null,
    });
  }

  /** Direct employee assignments plus every rule assigned to a group the employee belongs to - the "effective work rules" view §1's build spec calls for. */
  async findForEmployee(employeeId: string): Promise<WorkRule[]> {
    const groupIds = await this.employeeGroupsService.findGroupIdsForEmployee(employeeId);
    const [direct, viaGroups] = await Promise.all([
      this.assignmentsRepository.findForAssignees(AssigneeType.EMPLOYEE, [employeeId]),
      this.assignmentsRepository.findForAssignees(AssigneeType.GROUP, groupIds),
    ]);
    const ruleIds = [...new Set([...direct, ...viaGroups].map((a) => a.workRuleId))];
    return this.workRulesRepository.findByIds(ruleIds);
  }

  /**
   * User Management audit GAP-05's real payoff: `findForEmployee` above
   * returns every applicable rule with no tie-break — fine for a "what
   * applies" list view, useless for anything that needs exactly one answer
   * (e.g. a scheduling engine deciding max weekly hours). Resolves to the
   * single highest-`priority` binding whose effective window covers
   * `asOfDate` (defaults to today), direct employee assignments breaking a
   * priority tie over group assignments, and the most recently assigned
   * breaking any remaining tie. `null` means no binding is currently
   * effective for this employee, not "no limit."
   */
  async findEffectiveForEmployee(employeeId: string, asOfDate?: string): Promise<WorkRule | null> {
    const today = asOfDate ?? new Date().toISOString().slice(0, 10);
    const groupIds = await this.employeeGroupsService.findGroupIdsForEmployee(employeeId);
    const [direct, viaGroups] = await Promise.all([
      this.assignmentsRepository.findForAssignees(AssigneeType.EMPLOYEE, [employeeId]),
      this.assignmentsRepository.findForAssignees(AssigneeType.GROUP, groupIds),
    ]);
    const inEffect = [...direct, ...viaGroups].filter(
      (a) => (!a.effectiveFrom || a.effectiveFrom <= today) && (!a.effectiveTo || a.effectiveTo >= today),
    );
    if (inEffect.length === 0) return null;
    inEffect.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      if (a.assigneeType !== b.assigneeType) return a.assigneeType === AssigneeType.EMPLOYEE ? -1 : 1;
      return b.assignedAt.getTime() - a.assignedAt.getTime();
    });
    return this.workRulesRepository.findByIdOrNull(inEffect[0].workRuleId);
  }
}
