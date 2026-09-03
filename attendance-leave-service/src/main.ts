// Must be the very first import - see tracing.ts's own doc comment.
import './tracing';
import 'reflect-metadata';
import { join } from 'path';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { AppModule } from './app.module';

/**
 * Module 06. Phase 1: schema/migrations + skeleton. Phase 2 (§3.2) added the
 * badge/biometric `clock-events` webhook. Phase 3 added `requestLeave`'s
 * synchronous conflict-check pipeline. Phase 4 added the BullMQ approval
 * workflow. Phase 5 (§3.4, ADR-0078) adds this service's first gRPC surface
 * (`LeaveService.GetUnavailability`, for scheduling-service's mid-solve
 * pull) and first NATS publish (`agno.leave.request.approved.v1`). Phase 6
 * (§5.1, ADR-0079) adds `submitBackdatedLeave`, the elevated
 * `backdated_leave_entry:approve` permission gate on approving a backdated
 * decision, and this service's first gRPC *client* (core's
 * `AuditService.RecordEvent`). Phase 7 (§5.2, ADR-0080) adds
 * `LeaveCarryoverJobService`, this service's first `@Cron` job, rolling
 * over/expiring carryover days across accrual periods. Phase 8 (§2.1,
 * ADR-0081) adds `AbsencePatternDetectionJob` (this service's second
 * `@Cron` job and second gRPC client, core's `CalendarService`),
 * `acknowledgeAbsencePattern`, and closes out this module's 8-phase build
 * - see docs/module-06-runbook.md for the operational reference spanning
 * all 8 phases. GraphQL (introduced alongside the mutations that need it)
 * was never triggered by any phase and remains unbuilt - see
 * docs/module-06-phase-*-design-doc.md.
 *
 * `rawBody: true` is required for `HmacSignatureGuard` (own copy of
 * intraday-service's) - it recomputes the HMAC over the exact bytes the
 * badge/biometric device signed, and Nest's default body-parser middleware
 * only exposes the already-JSON-parsed body, not guaranteed to
 * re-serialize byte-identically.
 *
 * `connectMicroservice`/`startAllMicroservices` mirrors core `src/main.ts`
 * exactly: gRPC is a second transport bolted onto the same `INestApplication`
 * created for HTTP, not a separate `NestFactory.createMicroservice` process.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  // Frontend gap-fix: the User Management console's Time Off screen (:5173)
  // now calls this service directly from the browser - same pattern/reasoning
  // as the root service's own main.ts CORS block.
  app.enableCors({
    origin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(','),
    credentials: true,
  });
  // Same reasoning as every other service's main.ts in this platform
  // (ADR-0042): without this, Nest never calls OnModuleDestroy on
  // SIGTERM/SIGINT.
  app.enableShutdownHooks();

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: ['agno.leave.v1'],
      protoPath: [join(__dirname, 'grpc/proto/leave.proto')],
      url: process.env.GRPC_URL ?? '0.0.0.0:7050',
    },
  });

  const port = Number(process.env.PORT ?? 8300);
  await app.startAllMicroservices();
  await app.listen(port);
  Logger.log(
    `Attendance & Leave Management (Module 06) listening on :${port} - ` +
      'POST /v1/attendance/tenants/:tenantId/clock-events, POST /v1/leave/requests, ' +
      'GET /v1/leave/requests, POST /v1/leave/backdated-requests, GET /v1/leave/absence-patterns, ' +
      'GET /v1/attendance/exceptions (Attendance & Leave Manager Views phase), ' +
      `gRPC ${process.env.GRPC_URL ?? '0.0.0.0:7050'} (LeaveService.GetUnavailability), ` +
      '/healthz, /readyz, /metrics',
    'Bootstrap',
  );
}

bootstrap();
