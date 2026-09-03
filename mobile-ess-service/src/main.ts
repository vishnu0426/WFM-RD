import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

/**
 * Module 11 Phase 3 (docs/adr/0151): `POST /v1/mobile/sync`, `clock_event`
 * only. No `rawBody: true` needed here - unlike attendance-leave-service's
 * own webhook ingestion, this service's own inbound endpoint is guarded by
 * `AccessTokenGuard`/`TenantTokenMatchGuard` (JWT + tenant match), not
 * HMAC; `rawBody` matters only for a service that itself verifies an HMAC
 * signature over exact request bytes, which this service does as a
 * CLIENT (`AttendanceClockEventClient`), not as a server.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  // Same reasoning as every other service's main.ts (ADR-0042): without
  // this, Nest never calls OnModuleDestroy on SIGTERM/SIGINT.
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 8800);
  await app.listen(port);
  Logger.log(
    `Mobile / Employee Self-Service (Module 11) listening on :${port} - ` +
      'POST /v1/mobile/sync, /healthz, /readyz, /metrics',
    'Bootstrap',
  );
}

bootstrap();
