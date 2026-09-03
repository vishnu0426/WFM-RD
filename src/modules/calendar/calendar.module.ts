import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkingTimeCalendar } from './entities/working-time-calendar.entity';
import { WorkingTimeCalendarHistory } from './entities/working-time-calendar-history.entity';
import { WorkingTimeCalendarsRepository } from './repositories/working-time-calendars.repository';
import { WorkingTimeCalendarHistoryRepository } from './repositories/working-time-calendar-history.repository';
import { WorkingTimeCalendarsService } from './services/working-time-calendars.service';
import { WorkingTimeCalendarResolver } from './graphql/working-time-calendar.resolver';
import { CalendarsController } from './rest/calendars.controller';
import { OrgUnitModule } from '../org-unit/org-unit.module';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';

/**
 * Imports `OrgUnitModule` (one direction) so `WorkingTimeCalendarsService`
 * can validate `orgUnitId`. `AuthModule` added (frontend Phase 1
 * prerequisite, for gating the calendar resolver/controller) - no cycle
 * risk, `AuthModule` doesn't import `CalendarModule`.
 *
 * `AuditModule` added for GAP-06 (enterprise readiness audit, 2026-08-18):
 * `WorkingTimeCalendarsService` now injects `AuditLogRepository` directly -
 * no cycle risk, same as every other module's own addition.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([WorkingTimeCalendar, WorkingTimeCalendarHistory]),
    OrgUnitModule,
    AuthModule,
    AuditModule,
  ],
  providers: [
    WorkingTimeCalendarsRepository,
    WorkingTimeCalendarHistoryRepository,
    WorkingTimeCalendarsService,
    WorkingTimeCalendarResolver,
  ],
  controllers: [CalendarsController],
  exports: [TypeOrmModule, WorkingTimeCalendarsRepository, WorkingTimeCalendarsService],
})
export class CalendarModule {}
