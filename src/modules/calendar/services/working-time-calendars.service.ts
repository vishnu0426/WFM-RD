import { Injectable } from '@nestjs/common';
import { WorkingTimeCalendarsRepository } from '../repositories/working-time-calendars.repository';
import { WorkingTimeCalendar } from '../entities/working-time-calendar.entity';
import { UpsertWorkingTimeCalendarInput } from '../dto/upsert-working-time-calendar.input';
import { OrgUnitsService } from '../../org-unit/services/org-units.service';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { AuditLogRepository } from '../../audit/repositories/audit-log.repository';
import { AuditActorType } from '../../audit/entities/audit-actor-type.enum';

/**
 * GAP-06 fix (enterprise readiness audit, 2026-08-18): `upsert` now records
 * an `audit_log` entry - same `AuditLogRepository.record(...)` pattern
 * every other audited service uses.
 */
@Injectable()
export class WorkingTimeCalendarsService {
  constructor(
    private readonly workingTimeCalendarsRepository: WorkingTimeCalendarsRepository,
    private readonly orgUnitsService: OrgUnitsService,
    private readonly tenantContext: TenantContextService,
    private readonly auditLog: AuditLogRepository,
  ) {}

  async findForOrgUnit(orgUnitId: string | null): Promise<WorkingTimeCalendar | null> {
    return orgUnitId
      ? this.workingTimeCalendarsRepository.findForOrgUnit(orgUnitId)
      : this.workingTimeCalendarsRepository.findTenantDefault();
  }

  /**
   * §3.2's "create/update" in one call, keyed by `orgUnitId`
   * (`uq_working_time_calendars_tenant_org_unit`/`uq_working_time_calendars_tenant_default`,
   * Phase 1, enforce at most one row per key at the DB level regardless).
   */
  async upsert(input: UpsertWorkingTimeCalendarInput): Promise<WorkingTimeCalendar> {
    const orgUnitId = input.orgUnitId ?? null;
    if (orgUnitId) {
      await this.orgUnitsService.findById(orgUnitId);
    }

    const existing = await this.findForOrgUnit(orgUnitId);
    const fields = {
      countryCode: input.countryCode,
      timezone: input.timezone,
      holidayDates: input.holidayDates,
      standardBusinessHours: input.standardBusinessHours,
    };

    if (existing) {
      await this.workingTimeCalendarsRepository.update({ id: existing.id } as never, fields as never);
      const updated = { ...existing, ...fields };
      await this.audit('calendar.updated', updated.id, existing, updated);
      return updated;
    }

    const created = await this.workingTimeCalendarsRepository.save({ orgUnitId, ...fields } as WorkingTimeCalendar);
    await this.audit('calendar.created', created.id, null, created);
    return created;
  }

  private async audit(
    action: string,
    resourceId: string,
    beforeState: WorkingTimeCalendar | null,
    afterState: WorkingTimeCalendar | null,
  ): Promise<void> {
    await this.auditLog.record({
      tenantId: this.tenantContext.requireTenantId(),
      actorId: this.tenantContext.getStore()?.actorId ?? null,
      actorType: AuditActorType.USER,
      action,
      resourceType: 'working_time_calendar',
      resourceId,
      beforeState: beforeState as unknown as Record<string, unknown> | null,
      afterState: afterState as unknown as Record<string, unknown> | null,
      aiRationale: null,
    });
  }
}
