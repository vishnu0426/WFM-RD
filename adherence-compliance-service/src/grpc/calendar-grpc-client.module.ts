import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { CalendarGrpcClientService } from './calendar-grpc-client.service';
import { CALENDAR_GRPC_PACKAGE } from './calendar-grpc-client.constants';

/**
 * §7 Phase 3/ADR-0099. A separate `ClientsModule.registerAsync` entry from
 * `EmployeeGrpcClientModule` - `CalendarService` and `EmployeeService` are
 * different proto files served by the same core process/port, and
 * `@nestjs/microservices`' gRPC transport binds one package per client
 * registration (same reasoning attendance-leave-service's own
 * `calendar-grpc-client.module.ts` states for its own second client).
 */
@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: CALENDAR_GRPC_PACKAGE,
        useFactory: () => ({
          transport: Transport.GRPC,
          options: {
            package: 'agno.org.v1',
            protoPath: join(process.cwd(), '../src/grpc/proto/calendar.proto'),
            url: process.env.CORE_GRPC_URL ?? 'localhost:5000',
          },
        }),
      },
    ]),
  ],
  providers: [CalendarGrpcClientService],
  exports: [CalendarGrpcClientService],
})
export class CalendarGrpcClientModule {}
