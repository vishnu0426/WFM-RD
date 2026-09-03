import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { WorkingTimeCalendarsService } from '../../modules/calendar/services/working-time-calendars.service';

interface GetWorkingTimeRulesRequest {
  tenantId: string;
  orgUnitId: string;
  fromDate: string;
  toDate: string;
}

/** §3.3's `CalendarService.GetWorkingTimeRules`. */
@Controller()
export class CalendarGrpcController {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly workingTimeCalendarsService: WorkingTimeCalendarsService,
  ) {}

  @GrpcMethod('CalendarService', 'GetWorkingTimeRules')
  async getWorkingTimeRules(request: GetWorkingTimeRulesRequest): Promise<Record<string, unknown>> {
    return this.tenantContext.run({ tenantId: request.tenantId }, async () => {
      const calendar = await this.workingTimeCalendarsService.findForOrgUnit(request.orgUnitId || null);
      if (!calendar) {
        return { countryCode: '', timezone: 'UTC', holidayDates: [], standardBusinessHoursJson: '{}' };
      }
      const holidaysInRange = calendar.holidayDates.filter((date) => {
        if (request.fromDate && date < request.fromDate) {
          return false;
        }
        if (request.toDate && date > request.toDate) {
          return false;
        }
        return true;
      });
      return {
        countryCode: calendar.countryCode,
        timezone: calendar.timezone,
        holidayDates: holidaysInRange,
        standardBusinessHoursJson: JSON.stringify(calendar.standardBusinessHours),
      };
    });
  }
}
