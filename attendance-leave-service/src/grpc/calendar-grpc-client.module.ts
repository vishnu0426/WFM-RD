import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { CalendarGrpcClientService } from './calendar-grpc-client.service';
import { CALENDAR_GRPC_PACKAGE } from './calendar-grpc-client.constants';

/**
 * Phase 8 (§2.1/ADR-0081): this service's second gRPC client (Phase 6 was
 * the first, `AuditService`). Calls core's already-existing
 * `CalendarService.GetWorkingTimeRules` (`src/grpc/controllers/calendar-grpc.controller.ts`)
 * for holiday dates - `AbsencePatternDetectionJob`'s `pre_post_holiday`
 * step needs a real holiday calendar, and Module 02 already owns and
 * serves one; this is not a stub or a permanently-deferred gap like
 * ADR-0076's org-coverage case.
 *
 * A second, separate `ClientsModule.registerAsync` entry, not a shared one
 * with `AuditGrpcClientModule` - `CalendarService` (`agno.org.v1`) and
 * `AuditService` (`agno.core.v1`) are different proto packages served by
 * the same core process/port, and `@nestjs/microservices`' gRPC transport
 * binds one package per client registration. Same `CORE_GRPC_URL`,
 * same `process.cwd()`-relative proto path reasoning as
 * `audit-grpc-client.module.ts` - see that file's own doc comment.
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
