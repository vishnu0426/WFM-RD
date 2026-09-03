import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { IngestionController } from './ingestion.controller';
import { IngestionService } from './ingestion.service';
import { HmacSignatureGuard } from './hmac-signature.guard';
import { MetricsModule } from '../common/metrics/metrics.module';
import { IngestionCredentialsModule } from '../ingestion-credentials/ingestion-credentials.module';

@Module({
  imports: [ConfigModule, MetricsModule, IngestionCredentialsModule],
  controllers: [IngestionController],
  providers: [IngestionService, HmacSignatureGuard],
  // Phase 4: `ActivityChangeResolver` (`reportActivityChange` mutation)
  // reuses this exact service - a manually-reported change and an
  // ACD-webhook-reported one share the same dedupe/publish semantics.
  exports: [IngestionService],
})
export class IngestionModule {}
