import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VaultModule } from '../vault/vault.module';
import { IngestionCredential } from './entities/ingestion-credential.entity';
import { IngestionCredentialsController } from './ingestion-credentials.controller';
import { IngestionCredentialsService } from './ingestion-credentials.service';

/** Replaces the `INTRADAY_WEBHOOK_SECRETS` env-var stopgap - see `IngestionCredentialsService`'s own doc comment. Exported so `IngestionModule` (`HmacSignatureGuard`) can inject `IngestionCredentialsService` without a circular module import. */
@Module({
  imports: [TypeOrmModule.forFeature([IngestionCredential]), VaultModule],
  controllers: [IngestionCredentialsController],
  providers: [IngestionCredentialsService],
  exports: [IngestionCredentialsService],
})
export class IngestionCredentialsModule {}
