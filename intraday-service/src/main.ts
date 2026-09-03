// Must be the very first import - see tracing.ts's own doc comment.
import './tracing';
import 'reflect-metadata';
import { join } from 'path';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { AppModule } from './app.module';

/**
 * Module 05: Phase 1 shipped the REST ingestion webhook; Phase 4 adds this
 * service's first GraphQL surface (queries/mutation/subscription,
 * `/graphql`, `graphql-ws` for subscriptions) and a REST snapshot fallback
 * (`GET /v1/intraday/queues/:queueId/live`) - see
 * `docs/module-05-phase-4-design-doc.md`.
 *
 * `rawBody: true` is required for `HmacSignatureGuard` - it recomputes the
 * HMAC over the exact bytes the ACD/CCaaS system signed, and Nest's default
 * body-parser middleware only exposes the already-JSON-parsed body, which is
 * not guaranteed to re-serialize byte-identically.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  // Same CORS_ORIGIN convention as ai-layer-service's own main.ts - the only
  // browser client crossing an Origin boundary is the web-console SPA. Was
  // missing here (unlike ai-layer-service) until the Live Ops dashboard
  // (web-console/src/features/live-ops) needed to call this service's
  // GraphQL queries/mutations directly from the browser and every request
  // failed CORS preflight.
  app.enableCors({
    origin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(','),
    credentials: true,
  });
  // Same reasoning as the root app's main.ts (ADR-0042): without this, Nest
  // never calls OnModuleDestroy on SIGTERM/SIGINT, so NatsClientService's
  // connection.drain() would never run on a routine deploy/restart.
  app.enableShutdownHooks();

  // Module 10 Phase 4 (docs/adr/0120): this service's first gRPC surface -
  // a second transport bolted onto the same `INestApplication`, same
  // pattern as core's/adherence-compliance-service's own main.ts.
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: ['agno.intraday.v1'],
      protoPath: [join(__dirname, 'grpc/proto/reallocation.proto')],
      url: process.env.GRPC_URL ?? '0.0.0.0:7200',
    },
  });

  const port = Number(process.env.PORT ?? 8200);
  await app.startAllMicroservices();
  await app.listen(port);
  Logger.log(
    `Intraday/Real-Time Management (Module 05) listening on :${port} - ` +
      'REST /v1/intraday/tenants/:tenantId/activity-events, GraphQL /graphql (+ graphql-ws subscriptions), ' +
      'REST /v1/intraday/queues/:queueId/live, /healthz, /readyz, /metrics, ' +
      `gRPC ${process.env.GRPC_URL ?? '0.0.0.0:7200'} (ReallocationService.GetReallocationForExplanation)`,
    'Bootstrap',
  );
}

bootstrap();
