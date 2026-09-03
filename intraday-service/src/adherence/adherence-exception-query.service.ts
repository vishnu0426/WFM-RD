import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { withTenantConnection } from '../database/with-tenant-connection';
import { AdherenceException, AdherenceExceptionStatus } from './entities/adherence-exception.entity';

export interface ListAdherenceExceptionsFilter {
  status?: AdherenceExceptionStatus;
  employeeId?: string;
}

/** List query behind `GET /v1/intraday/adherence-exceptions` - same "plain filtered find, newest first" shape `AlertQueryService.listActiveAlerts` uses, but with real filters since a scorecard view needs to slice by status and by employee, not just "active." */
@Injectable()
export class AdherenceExceptionQueryService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async list(tenantId: string, filter: ListAdherenceExceptionsFilter): Promise<AdherenceException[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.getRepository(AdherenceException).find({
        where: {
          tenantId,
          ...(filter.status ? { status: filter.status } : {}),
          ...(filter.employeeId ? { employeeId: filter.employeeId } : {}),
        },
        order: { startedAt: 'DESC' },
      }),
    );
  }
}
