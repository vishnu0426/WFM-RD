import { BadRequestException, Injectable } from '@nestjs/common';
import { EmployeeSchedulePreferencesRepository } from '../repositories/employee-schedule-preferences.repository';
import { EmployeeSchedulePreference } from '../entities/employee-schedule-preference.entity';
import { UpsertEmployeeSchedulePreferenceInput } from '../dto/upsert-employee-schedule-preference.input';
import { EmployeesService } from '../../employee/services/employees.service';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { AuditLogRepository } from '../../audit/repositories/audit-log.repository';
import { AuditActorType } from '../../audit/entities/audit-actor-type.enum';

@Injectable()
export class EmployeeSchedulePreferencesService {
  constructor(
    private readonly preferencesRepository: EmployeeSchedulePreferencesRepository,
    private readonly employeesService: EmployeesService,
    private readonly tenantContext: TenantContextService,
    private readonly auditLog: AuditLogRepository,
  ) {}

  async findForEmployee(employeeId: string): Promise<EmployeeSchedulePreference | null> {
    return this.preferencesRepository.findForEmployee(employeeId);
  }

  /**
   * Explicit find-then-update-or-insert, same shape as
   * `EmployeeSkillsService.updateForEmployee` - not relying on TypeORM's
   * implicit "save() with a PK set merges" behavior, which resolves
   * existence via its own SELECT anyway and is easy to get wrong across
   * driver versions.
   */
  async upsertForEmployee(input: UpsertEmployeeSchedulePreferenceInput): Promise<EmployeeSchedulePreference> {
    await this.employeesService.findById(input.employeeId);
    if (input.preferenceSlots) {
      const ranks = input.preferenceSlots.map((s) => s.rank);
      if (new Set(ranks).size !== ranks.length) {
        throw new BadRequestException('preferenceSlots ranks must be unique (one slot per rank).');
      }
    }
    const tenantId = this.tenantContext.requireTenantId();
    const actorId = this.tenantContext.getStore()?.actorId ?? null;
    const before = await this.preferencesRepository.findForEmployee(input.employeeId);

    const fields: Partial<EmployeeSchedulePreference> = {
      preferredShiftStart: input.preferredShiftStart ?? null,
      preferredShiftEnd: input.preferredShiftEnd ?? null,
      preferredDaysOff: input.preferredDaysOff ?? null,
      maxWeeklyHours: input.maxWeeklyHours != null ? String(input.maxWeeklyHours) : null,
      notes: input.notes ?? null,
      preferenceSlots: input.preferenceSlots
        ? [...input.preferenceSlots].sort((a, b) => a.rank - b.rank).map((s) => ({
            rank: s.rank,
            startTime: s.startTime ?? null,
            endTime: s.endTime ?? null,
            earlyLate: s.earlyLate ?? null,
          }))
        : null,
      updatedBy: actorId,
    };

    if (before) {
      await this.preferencesRepository.update({ employeeId: input.employeeId } as never, fields as never);
    } else {
      await this.preferencesRepository.save({ employeeId: input.employeeId, ...fields } as EmployeeSchedulePreference);
    }
    const after = (await this.preferencesRepository.findForEmployee(input.employeeId))!;

    await this.auditLog.record({
      tenantId,
      actorId,
      actorType: AuditActorType.USER,
      action: 'employee_schedule_preference.upserted',
      resourceType: 'employee',
      resourceId: input.employeeId,
      beforeState: before ? (before as unknown as Record<string, unknown>) : null,
      afterState: after as unknown as Record<string, unknown>,
      aiRationale: null,
    });
    return after;
  }
}
