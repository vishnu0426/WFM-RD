// Must be the very first import - see tracing.ts's own doc comment for why
// (OTel auto-instrumentation has to patch http/express/pg/ioredis before
// anything else requires them).
import './tracing';
import 'reflect-metadata';
import { join } from 'path';
import { json, urlencoded } from 'express';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { AppModule } from './app.module';

/**
 * Module 02 Phase 2 mounted the first HTTP/GraphQL surface in this repo -
 * `GET /v1/org-units/{id}/tree` (REST) and the Apollo GraphQL endpoint at
 * `/graphql`, both gated by `TenantContextMiddleware`. Module 02 Phase 7
 * added a second, internal transport: a gRPC microservice (§3.3, ADR-0021)
 * alongside the same HTTP app, listening on `GRPC_URL` (default
 * `0.0.0.0:5000`).
 *
 * Module 01 Phase 2 added this repo's actual OAuth2.1/OIDC token-issuing
 * surface (`/oauth/*`, `/.well-known/*` - see `AuthModule`) and the
 * `IdentityService` gRPC contract every other internal service calls to
 * validate a token and fetch a caller's roles/permissions. Module 01
 * Phase 7 (ADR-0049) replaced `TenantContextMiddleware`'s original
 * header-trust placeholder with real JWT-derived tenant binding whenever a
 * valid `Authorization: Bearer` token is present - see that middleware's
 * doc comment for the cross-tenant bypass this closes.
 */
async function bootstrap(): Promise<void> {
  // bodyParser: false + explicit json()/urlencoded() below, so the default
  // 100kb Express body limit can be raised - BulkImportController's own doc
  // comment calls it "the highest-blast-radius write surface in Module 02
  // (can touch thousands of employee records in one call)," and a few
  // hundred employee records already exceeds 100kb as JSON. Every other
  // route keeps ordinary request-body behavior; this only widens the limit.
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const bodyLimit = process.env.HTTP_BODY_LIMIT ?? '10mb';
  app.use(json({ limit: bodyLimit }));
  app.use(urlencoded({ extended: true, limit: bodyLimit }));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  // The web-console admin UI (web-console/) is this repo's first browser
  // client, calling this API cross-origin (its own dev/deployed origin, not
  // this service's). Nothing before it needed CORS at all. Origin list is
  // env-driven rather than '*' since requests carry Authorization headers
  // and credentials: true, which the CORS spec forbids combining with a
  // wildcard origin anyway.
  app.enableCors({
    origin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(','),
    credentials: true,
  });
  // ADR-0042: without this, Nest never calls OnModuleDestroy hooks on
  // SIGTERM/SIGINT - AuditEventBatcherService's best-effort final flush
  // would silently never run on a routine deploy/restart.
  app.enableShutdownHooks();

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: ['agno.org.v1', 'agno.core.v1'],
      protoPath: [
        join(__dirname, 'grpc/proto/employee.proto'),
        join(__dirname, 'grpc/proto/calendar.proto'),
        join(__dirname, 'grpc/proto/identity.proto'),
        join(__dirname, 'grpc/proto/policy.proto'),
        join(__dirname, 'grpc/proto/audit.proto'),
        join(__dirname, 'grpc/proto/notification.proto'),
      ],
      url: process.env.GRPC_URL ?? '0.0.0.0:5000',
    },
  });

  const port = Number(process.env.PORT ?? 3000);
  await app.startAllMicroservices();
  await app.listen(port);
  Logger.log(
    `Platform Core (Module 01) + Org & Employee (Module 02) listening on :${port} - REST /v1/org-units, ` +
      `/oauth/*, /.well-known/*, GraphQL /graphql, gRPC ${process.env.GRPC_URL ?? '0.0.0.0:5000'}`,
    'Bootstrap',
  );
}

bootstrap();
