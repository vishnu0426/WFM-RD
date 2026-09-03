// Must be the very first import - see tracing.ts's own doc comment.
import './tracing';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

/**
 * Module 12 (Integration Hub). Phase 1: schema/migrations + skeleton - see
 * docs/module-12-phase-1-design-doc.md. No connector framework, no
 * mutation/query surface, no Vault integration, no NATS, no gRPC client
 * into Module 05 yet - those are Phase 2+ per §7's own build-phase list.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  // Frontend gap-fix: the User Management console (frontend/, :5173) now
  // calls `connectors` directly from the browser for the Employee "Data
  // Source" picker - same reasoning/pattern as the root service's own
  // main.ts CORS block (env-driven allowlist, not '*', since requests
  // carry an Authorization header).
  app.enableCors({
    origin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(','),
    credentials: true,
  });
  // Same reasoning as every other service's main.ts in this platform
  // (ADR-0042): without this, Nest never calls OnModuleDestroy on
  // SIGTERM/SIGINT.
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 8900);
  await app.listen(port);
  Logger.log(`Integration Hub (Module 12) listening on :${port} - /healthz, /readyz, /metrics`, 'Bootstrap');
}

bootstrap();
