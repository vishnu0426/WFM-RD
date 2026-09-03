import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from './entities/audit-log.entity';
import { PendingAuditEvent } from './entities/pending-audit-event.entity';
import { AuditLogRepository } from './repositories/audit-log.repository';
import { PendingAuditEventsRepository } from './repositories/pending-audit-events.repository';
import { AuditEventBatcherService } from './services/audit-event-batcher.service';
import { CoreEventingModule } from '../core-eventing/core-eventing.module';

/**
 * Phase 5 (§8): imports `CoreEventingModule` so `AuditLogRepository.record`
 * can write its transactional outbox row (ADR-0039). Deliberately does NOT
 * import `AuthModule` (unlike the original Phase 5 cut) - `AuthModule`
 * itself now needs `AuditEventBatcherService` (§5's follow-up: OAuth token/
 * revoke/register instrumentation, ADR-0044), and `AuditModule` importing
 * `AuthModule` back would make that circular. `AuditLogController` (which
 * *does* need `AuthModule`'s guards) lives in `AuditApiModule` instead - the
 * same composition-root pattern as `PolicyApiModule`/`IdentityApiModule`
 * (ADR-0037), applied here for the first time in this direction.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AuditLog, PendingAuditEvent]), CoreEventingModule],
  providers: [AuditLogRepository, PendingAuditEventsRepository, AuditEventBatcherService],
  exports: [TypeOrmModule, AuditLogRepository, PendingAuditEventsRepository, AuditEventBatcherService],
})
export class AuditModule {}
