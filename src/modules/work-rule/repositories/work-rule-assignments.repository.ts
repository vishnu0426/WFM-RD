import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantScopedRepository } from '../../../common/tenant/tenant-scoped.repository';
import { WorkRuleAssignment } from '../entities/work-rule-assignment.entity';
import { AssigneeType } from '../entities/assignee-type.enum';

@Injectable()
export class WorkRuleAssignmentsRepository extends TenantScopedRepository<WorkRuleAssignment> {
  constructor(dataSource: DataSource, tenantContext: TenantContextService) {
    super(dataSource, WorkRuleAssignment, tenantContext);
  }

  async findForWorkRule(workRuleId: string): Promise<WorkRuleAssignment[]> {
    return this.find({ where: { workRuleId } as never });
  }

  /** `assigneeIds` is one employee id plus every group id that employee belongs to - the caller resolves group membership first (WorkRulesService.findForEmployee). */
  async findForAssignees(assigneeType: AssigneeType, assigneeIds: string[]): Promise<WorkRuleAssignment[]> {
    if (assigneeIds.length === 0) return [];
    const all = await this.find({ where: { assigneeType } as never });
    const idSet = new Set(assigneeIds);
    return all.filter((a) => idSet.has(a.assigneeId));
  }

  async exists(workRuleId: string, assigneeType: AssigneeType, assigneeId: string): Promise<boolean> {
    return (await this.findOne({ where: { workRuleId, assigneeType, assigneeId } as never })) !== null;
  }

  async remove(workRuleId: string, assigneeType: AssigneeType, assigneeId: string): Promise<void> {
    await this.delete({ workRuleId, assigneeType, assigneeId } as never);
  }
}
