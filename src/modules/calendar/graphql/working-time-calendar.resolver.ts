import { UseGuards } from '@nestjs/common';
import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import { WorkingTimeCalendarGraphQLType } from './working-time-calendar.type';
import { WorkingTimeCalendarHistoryEntryType } from './working-time-calendar-history-entry.type';
import { WorkingTimeCalendarsService } from '../services/working-time-calendars.service';
import { WorkingTimeCalendarHistoryRepository } from '../repositories/working-time-calendar-history.repository';
import { AccessTokenGuard } from '../../auth/rest/access-token.guard';
import { PermissionsGuard } from '../../auth/rest/permissions.guard';
import { RequirePermissions } from '../../auth/rest/require-permissions.decorator';

/**
 * Gated for the first time here (frontend Phase 1 prerequisite), same
 * `employee` resource reasoning as `OrgUnitResolver`'s own doc comment.
 */
@Resolver(() => WorkingTimeCalendarGraphQLType)
@UseGuards(AccessTokenGuard, PermissionsGuard)
export class WorkingTimeCalendarResolver {
  constructor(
    private readonly workingTimeCalendarsService: WorkingTimeCalendarsService,
    private readonly workingTimeCalendarHistoryRepository: WorkingTimeCalendarHistoryRepository,
  ) {}

  /** `orgUnitId` omitted = the tenant-wide default calendar. */
  @Query(() => WorkingTimeCalendarGraphQLType, { nullable: true })
  @RequirePermissions('employee:read')
  async workingTimeCalendar(
    @Args('orgUnitId', { type: () => ID, nullable: true }) orgUnitId?: string,
  ): Promise<WorkingTimeCalendarGraphQLType | null> {
    return this.workingTimeCalendarsService.findForOrgUnit(orgUnitId ?? null);
  }

  /**
   * GAP-07 fix (enterprise readiness audit, 2026-08-18): full lineage,
   * oldest first - same shape as `EmployeeResolver.employeeHistory`.
   */
  @Query(() => [WorkingTimeCalendarHistoryEntryType])
  @RequirePermissions('employee:read')
  async workingTimeCalendarHistory(
    @Args('calendarId', { type: () => ID }) calendarId: string,
  ): Promise<WorkingTimeCalendarHistoryEntryType[]> {
    return this.workingTimeCalendarHistoryRepository.findHistory(calendarId);
  }
}
