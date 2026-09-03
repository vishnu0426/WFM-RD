// Must be the very first import - see tracing.ts's own doc comment.
import './tracing';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

/**
 * Module 07 (Shift Marketplace). Phase 1: schema/migrations + skeleton -
 * see app.module.ts's own doc comment for what later phases add and when.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  // Same reasoning as every other service's main.ts in this platform
  // (ADR-0042): without this, Nest never calls OnModuleDestroy on
  // SIGTERM/SIGINT.
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 8400);
  await app.listen(port);
  Logger.log(`Shift Marketplace (Module 07) listening on :${port} - /healthz, /readyz, /metrics`, 'Bootstrap');
}

bootstrap();
