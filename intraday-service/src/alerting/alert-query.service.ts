import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { withTenantConnection } from '../database/with-tenant-connection';
import { Alert } from './entities/alert.entity';

/** `activeAlerts` (§4.1) - `open`/`acknowledged` only; a full suppressed/resolved audit query is not built this phase (design doc "Out of scope"). */
@Injectable()
export class AlertQueryService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async listActiveAlerts(tenantId: string): Promise<Alert[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.getRepository(Alert).find({
        where: { tenantId, status: In(['open', 'acknowledged']) },
        order: { createdAt: 'DESC' },
      }),
    );
  }
}
