// Must be the very first import - see tracing.ts's own doc comment.
import './tracing';
import 'reflect-metadata';
import { join } from 'path';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { AppModule } from './app.module';

/**
 * Module 10 (AI Layer). Phase 1: schema/migrations + skeleton only. Phase 2
 * adds this service's first real capability - GraphQL `explainSchedule`.
 *
 * §1/§6's original framing - "GraphQL as the primary API surface, gRPC
 * only as an outbound client to other modules" - held through Phase 9, but
 * ADR-0165 reverses the gRPC half of it: `askAnalyticsQuestion`
 * (analytics-reporting-service, ADR-0111) needs Module 10 to translate a
 * question and generate an answer, and nothing in this platform lets one
 * backend service call into another's GraphQL API authenticated as
 * itself (client_credentials tokens carry no permissions/roles by design,
 * §5.1 Phase 2) - a gRPC server, the same zero-auth-at-this-layer,
 * internal-network-trust model every other inter-service call in this
 * platform already uses, is the smallest real fix. `NlQueryBridgeService`
 * is that surface - this main.ts now bolts on a second `Transport.GRPC`
 * microservice, same "second transport on the same `INestApplication`"
 * pattern adherence-compliance-service's own main.ts established in its
 * own Phase 4.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  // Same CORS_ORIGIN convention as the root app's own src/main.ts - the
  // only browser client crossing an Origin boundary is the web-console SPA.
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
      package: ['agno.ai_layer.v1'],
      protoPath: [join(__dirname, 'grpc/proto/nl_query_bridge.proto')],
      url: process.env.GRPC_URL ?? '0.0.0.0:7300',
    },
  });

  const port = Number(process.env.PORT ?? 8700);
  await app.startAllMicroservices();
  await app.listen(port);
  Logger.log(
    `AI Layer (Module 10) listening on :${port} - /healthz, /readyz, /metrics, GraphQL /graphql, ` +
      `gRPC ${process.env.GRPC_URL ?? '0.0.0.0:7300'} (NlQueryBridgeService.TranslateQuestion/GenerateAnswer)`,
    'Bootstrap',
  );
}

bootstrap();
