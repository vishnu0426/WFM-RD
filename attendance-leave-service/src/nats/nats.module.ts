import { Module } from '@nestjs/common';
import { AttendanceLeaveNatsClientService } from './nats-client.service';

@Module({
  providers: [AttendanceLeaveNatsClientService],
  exports: [AttendanceLeaveNatsClientService],
})
export class AttendanceLeaveNatsModule {}
