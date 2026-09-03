import { Controller, Logger } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { EmployeesRepository } from '../../modules/employee/repositories/employees.repository';
import { NotificationPreferencesRepository } from '../../modules/notification/repositories/notification-preferences.repository';
import { NotificationChannel } from '../../modules/notification/entities/notification-channel.enum';
import { WorkingTimeCalendarsService } from '../../modules/calendar/services/working-time-calendars.service';

interface IsPushEnabledRequest {
  tenantId: string;
  employeeId: string;
  eventType: string;
}

interface IsPushEnabledResponse {
  enabled: boolean;
  employeeHasLinkedUser: boolean;
}

/**
 * ADR-0154. Tenant context bound explicitly from the request message's own
 * `tenant_id`, same posture as `PolicyGrpcController`/`EmployeeGrpcController`
 * (no HTTP middleware in this transport, ADR-0021).
 */
@Controller()
export class NotificationPreferenceGrpcController {
  private readonly logger = new Logger(NotificationPreferenceGrpcController.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly employeesRepository: EmployeesRepository,
    private readonly notificationPreferencesRepository: NotificationPreferencesRepository,
    private readonly workingTimeCalendarsService: WorkingTimeCalendarsService,
  ) {}

  @GrpcMethod('NotificationPreferenceService', 'IsPushEnabled')
  async isPushEnabled(request: IsPushEnabledRequest): Promise<IsPushEnabledResponse> {
    return this.tenantContext.run({ tenantId: request.tenantId }, async () => {
      const employee = await this.employeesRepository.findById(request.employeeId);
      if (!employee?.userId) {
        this.logger.debug(
          `IsPushEnabled: employee ${request.employeeId} has no linked user account - defaulting to enabled`,
        );
        return { enabled: true, employeeHasLinkedUser: false };
      }

      const prefs = await this.notificationPreferencesRepository.findForUser(employee.userId);
      const pref = prefs.find((p) => p.channel === NotificationChannel.PUSH && p.eventType === request.eventType);
      if (!pref || !pref.enabled) {
        return { enabled: pref ? pref.enabled : true, employeeHasLinkedUser: true };
      }

      if (pref.quietHoursStart && pref.quietHoursEnd) {
        const inQuietHours = await this.isWithinQuietHours(
          employee.orgUnitId,
          pref.quietHoursStart,
          pref.quietHoursEnd,
        );
        if (inQuietHours) {
          return { enabled: false, employeeHasLinkedUser: true };
        }
      }

      return { enabled: true, employeeHasLinkedUser: true };
    });
  }

  /**
   * Module 11 Gap 4 (docs/adr/0154's disclosed "quiet hours are stored but
   * never enforced" gap). Resolves the employee's timezone in-process
   * (`employee.orgUnitId` -> `WorkingTimeCalendarsService.findForOrgUnit`,
   * the same primitive `CalendarGrpcController` already uses - no new gRPC
   * hop) and checks "now, in local time, within [start, end)," handling a
   * window that wraps midnight (e.g. `22:00` -> `07:00`). Fails open (any
   * lookup/parse failure -> not quiet hours, send anyway) - same posture
   * ADR-0155 already established for geofencing infra failures.
   */
  private async isWithinQuietHours(
    orgUnitId: string | null,
    quietHoursStart: string,
    quietHoursEnd: string,
  ): Promise<boolean> {
    try {
      const calendar = await this.workingTimeCalendarsService.findForOrgUnit(orgUnitId);
      const zone = this.safeZone(calendar?.timezone);
      const localMinutes = this.toZonedMinutesOfDay(new Date(), zone);
      const startMinutes = this.parseTimeToMinutes(quietHoursStart);
      const endMinutes = this.parseTimeToMinutes(quietHoursEnd);

      if (startMinutes === endMinutes) {
        return false;
      }
      return startMinutes < endMinutes
        ? localMinutes >= startMinutes && localMinutes < endMinutes
        : localMinutes >= startMinutes || localMinutes < endMinutes;
    } catch (err) {
      this.logger.warn(`Quiet-hours check failed - failing open (not quiet hours): ${(err as Error).message}`);
      return false;
    }
  }

  /** Falls back to UTC for no calendar, or an unparseable zone name - same posture `SkillDecaySchedulerService.safeZone` already established. */
  private safeZone(timezone: string | undefined): string {
    if (!timezone) {
      return 'UTC';
    }
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
      return timezone;
    } catch {
      this.logger.warn(`Unrecognized WorkingTimeCalendar.timezone "${timezone}" - falling back to UTC.`);
      return 'UTC';
    }
  }

  private toZonedMinutesOfDay(date: Date, timeZone: string): number {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
    return Number(parts.hour) * 60 + Number(parts.minute);
  }

  /** `quiet_hours_start`/`_end` are Postgres `time` columns, read back as `"HH:MM:SS"`. */
  private parseTimeToMinutes(time: string): number {
    const [hour, minute] = time.split(':').map(Number);
    return hour * 60 + minute;
  }
}
