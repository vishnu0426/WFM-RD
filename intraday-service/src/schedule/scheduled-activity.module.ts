import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleServiceClient } from './schedule-service-client';
import { ScheduledActivityService } from './scheduled-activity.service';
import { ShiftStartPreloadSchedulerService } from './shift-start-preload-scheduler.service';

/**
 * Named `ScheduledActivityModule`, not `ScheduleModule` - `@nestjs/schedule`
 * (needed for `ShiftStartPreloadSchedulerService`'s `@Cron`) already owns
 * that name platform-wide.
 */
@Module({
  imports: [ConfigModule],
  providers: [ScheduleServiceClient, ScheduledActivityService, ShiftStartPreloadSchedulerService],
  exports: [ScheduledActivityService],
})
export class ScheduledActivityModule {}
