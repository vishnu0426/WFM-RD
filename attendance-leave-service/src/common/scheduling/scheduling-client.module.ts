import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleServiceClient } from './schedule-service-client';

@Module({
  imports: [ConfigModule],
  providers: [ScheduleServiceClient],
  exports: [ScheduleServiceClient],
})
export class SchedulingClientModule {}
