// Must be the very first import - see tracing.ts's own doc comment.
import './tracing';
import 'reflect-metadata';
import { join } from 'path';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { AppModule } from './app.module';

/**
 * Module 08 (Adherence & Compliance). Phase 1: schema/migrations + skeleton
 * only - see docs/module-08-phase-1-design-doc.md. Phase 2 (§3.1/§3.2) adds
 * `createComplianceRule`/`activateComplianceRule` and REST/GraphQL rule
 * management. Phase 3 adds the rollup job runner (ADR-0094). Phase 4
 * (§3.3, ADR-0095) adds this service's first gRPC surface
 * (`ComplianceRuleService.GetActiveRule`/`ValidatePolicyAgainstFloor`, for
 * Module 02/04 to call) and the actual Module 02/04 reconciliation work
 * (§0.6). Phase 5 (§5a) adds the rule-change impact preview. Phase 6
 * (§3.2) adds async `generateComplianceReport` + S3 export. Phase 7 (§5b,
 * ADR-0096) adds the retention/lifecycle `@Cron` job. Phase 8 closes out
 * this module's 8-phase build with observability/hardening - see
 * docs/module-08-runbook.md once it exists.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  // Same CORS_ORIGIN convention as ai-layer-service's own main.ts - the only
  // browser client crossing an Origin boundary is the web-console SPA. Was
  // missing here until the Live Ops Adherence Board (web-console/src/
  // features/live-ops) needed to call adherenceScoreToday directly from the
  // browser and it failed CORS preflight.
  app.enableCors({
    origin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(','),
    credentials: true,
  });
  // Same reasoning as every other service's main.ts in this platform
  // (ADR-0042): without this, Nest never calls OnModuleDestroy on
  // SIGTERM/SIGINT.
  app.enableShutdownHooks();

  // gRPC is a second transport bolted onto the same `INestApplication`
  // created for HTTP, not a separate `NestFactory.createMicroservice`
  // process - same pattern as core's/attendance-leave-service's own main.ts.
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: ['agno.compliance.v1'],
      protoPath: [join(__dirname, 'grpc/proto/compliance.proto')],
      url: process.env.GRPC_URL ?? '0.0.0.0:7100',
    },
  });

  const port = Number(process.env.PORT ?? 8500);
  await app.startAllMicroservices();
  await app.listen(port);
  Logger.log(
    `Adherence & Compliance (Module 08) listening on :${port} - /healthz, /readyz, /metrics, ` +
      `gRPC ${process.env.GRPC_URL ?? '0.0.0.0:7100'} (ComplianceRuleService.GetActiveRule/ValidatePolicyAgainstFloor, ` +
      'AdherenceRollupService.GetOrgUnitAdherenceSummary)',
    'Bootstrap',
  );
}

bootstrap();
