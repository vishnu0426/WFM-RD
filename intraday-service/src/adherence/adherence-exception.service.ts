import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AdherenceExceptionAlreadyResolvedError } from '../common/errors/adherence-exception-already-resolved.error';
import { AdherenceExceptionNotFoundError } from '../common/errors/adherence-exception-not-found.error';
import { withTenantConnection } from '../database/with-tenant-connection';
import { AdherenceException } from './entities/adherence-exception.entity';

/**
 * `acknowledge`/`resolve` - same shape `AlertAcknowledgeService` already
 * established for `Alert` (plain `findOne` + save, no pessimistic lock:
 * a supervisor acknowledging/resolving twice is a harmless idempotent
 * overwrite, not a side-effecting action like `ReallocationApprovalService.approve`
 * that a race could double-execute).
 */
@Injectable()
export class AdherenceExceptionService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async acknowledge(tenantId: string, id: string, actorId: string): Promise<AdherenceException> {
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const repository = manager.getRepository(AdherenceException);
      const exception = await repository.findOne({ where: { tenantId, id } });
      if (!exception) {
        throw new AdherenceExceptionNotFoundError(id);
      }
      if (exception.status === 'resolved') {
        throw new AdherenceExceptionAlreadyResolvedError(id);
      }
      exception.status = 'acknowledged';
      exception.acknowledgedBy = actorId;
      exception.acknowledgedAt = new Date();
      await repository.save(exception);
      return exception;
    });
  }

  async resolve(tenantId: string, id: string, resolutionNotes: string): Promise<AdherenceException> {
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const repository = manager.getRepository(AdherenceException);
      const exception = await repository.findOne({ where: { tenantId, id } });
      if (!exception) {
        throw new AdherenceExceptionNotFoundError(id);
      }
      if (exception.status === 'resolved') {
        throw new AdherenceExceptionAlreadyResolvedError(id);
      }
      exception.status = 'resolved';
      exception.resolutionNotes = resolutionNotes;
      exception.resolvedAt = new Date();
      await repository.save(exception);
      return exception;
    });
  }
}
