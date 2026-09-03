import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AlertNotFoundError } from '../common/errors/alert-not-found.error';
import { withTenantConnection } from '../database/with-tenant-connection';
import { Alert } from './entities/alert.entity';

/** `acknowledgeAlert` (§4.1) - requires an actor identity (design doc assumption 3, `TenantContextService.requireActorId()`). */
@Injectable()
export class AlertAcknowledgeService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async acknowledge(tenantId: string, alertId: string, actorId: string): Promise<Alert> {
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const repository = manager.getRepository(Alert);
      const alert = await repository.findOne({ where: { tenantId, id: alertId } });
      if (!alert) {
        throw new AlertNotFoundError(alertId);
      }
      alert.status = 'acknowledged';
      alert.acknowledgedBy = actorId;
      alert.acknowledgedAt = new Date();
      await repository.save(alert);
      return alert;
    });
  }
}
