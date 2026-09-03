// Must be the very first import - see tracing.ts's own doc comment.
import './tracing';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

/**
 * Module 09 (Analytics & Reporting). Phase 1: schema/migrations + skeleton
 * only - see docs/module-09-phase-1-design-doc.md. Phase 2 adds the MV
 * refresh runner + read-replica wiring. Phase 4 adds this service's
 * primary API surface (GraphQL `dashboard`/`metricQuery`/`executiveSummary`,
 * REST `GET /v1/analytics/metrics/{metricName}`). No gRPC surface is
 * planned for this module (§4 lists GraphQL + REST only) - unlike Module
 * 08, this main.ts never bolts on a second `Transport.GRPC` microservice.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  // Tenant Monitoring dashboard (frontend/src/modules/tenant-monitoring): the
  // first browser-originated caller this service has ever had - every prior
  // consumer was server-side (a BI connector, GraphQL from a backend) or,
  // for the frontend's own `analytics-reporting` module folder, an unwired
  // stub. Same origin-allowlist + credentials shape as the root service's
  // own `main.ts` (ADR-0042's CORS precedent) - a wildcard origin can't be
  // combined with `credentials: true` per the CORS spec anyway, and these
  // requests carry an `Authorization` bearer header.
  app.enableCors({
    origin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(','),
    credentials: true,
  });
  // Same reasoning as every other service's main.ts in this platform
  // (ADR-0042): without this, Nest never calls OnModuleDestroy on
  // SIGTERM/SIGINT.
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 8600);
  await app.listen(port);
  Logger.log(`Analytics & Reporting (Module 09) listening on :${port} - /healthz, /readyz, /metrics`, 'Bootstrap');
}

bootstrap();
