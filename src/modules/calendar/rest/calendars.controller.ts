import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { WorkingTimeCalendarsService } from '../services/working-time-calendars.service';
import { UpsertWorkingTimeCalendarInput } from '../dto/upsert-working-time-calendar.input';
import { WorkingTimeCalendar } from '../entities/working-time-calendar.entity';
import { AccessTokenGuard } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';

/**
 * §3.2's `POST /v1/calendars`. Gated for the first time here (frontend
 * Phase 1 prerequisite), same `employee:write` reasoning as the GraphQL
 * calendar/skill/org-unit resolvers.
 */
@Controller('v1/calendars')
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class CalendarsController {
  constructor(private readonly workingTimeCalendarsService: WorkingTimeCalendarsService) {}

  @Post()
  @RequirePermissions('employee:write')
  async upsert(@Body() input: UpsertWorkingTimeCalendarInput): Promise<WorkingTimeCalendar> {
    return this.workingTimeCalendarsService.upsert(input);
  }
}
