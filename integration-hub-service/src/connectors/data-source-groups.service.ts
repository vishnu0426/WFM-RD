import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { withTenantConnection } from '../database/with-tenant-connection';
import { DataSourceGroup } from '../integrations/entities/data-source-group.entity';
import { DataSourceGroupQueue } from '../integrations/entities/data-source-group-queue.entity';
import { IntegrationConnector } from '../integrations/entities/integration-connector.entity';
import { ConnectorNotFoundError } from './errors/connector-not-found.error';
import { DataSourceGroupNotFoundError } from './errors/data-source-group-not-found.error';
import { CcQueueNotFoundError } from './errors/cc-queue-not-found.error';
import { ForecastingHttpClientService } from '../forecasting/forecasting-http-client.service';
import { AuditGrpcClientService } from '../grpc/audit-grpc-client.service';
import { Actor } from './integration-connectors.service';

export interface UpsertDataSourceGroupInput {
  dataSourceId: string;
  name: string;
  description?: string | null;
  type?: string | null;
  avgWorkTimeSeconds?: number | null;
}

/**
 * Tenant Admin Integration Management, WP3 (plan decision #4). Queue
 * membership (`addQueue`/`removeQueue`) validates `ccQueueId` against
 * forecasting-service's own real `CcQueue` rows before saving a membership
 * row - `data_source_group_queue.cc_queue_id` is a bare cross-service
 * reference with no DB-level FK (see that entity's own doc comment), so
 * this application-layer check is the only referential-integrity guard
 * that exists.
 */
@Injectable()
export class DataSourceGroupsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly forecasting: ForecastingHttpClientService,
    private readonly audit: AuditGrpcClientService,
  ) {}

  async findAllForTenant(tenantId: string, dataSourceId?: string): Promise<DataSourceGroup[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.getRepository(DataSourceGroup).find({
        where: dataSourceId ? { tenantId, dataSourceId } : { tenantId },
        order: { name: 'ASC' },
      }),
    );
  }

  async findByIdForTenant(tenantId: string, id: string): Promise<DataSourceGroup> {
    const row = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.findOne(DataSourceGroup, { where: { tenantId, id } }),
    );
    if (!row) throw new DataSourceGroupNotFoundError(id);
    return row;
  }

  async queuesForGroup(tenantId: string, groupId: string): Promise<DataSourceGroupQueue[]> {
    await this.findByIdForTenant(tenantId, groupId);
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.getRepository(DataSourceGroupQueue).find({ where: { tenantId, groupId }, order: { createdAt: 'ASC' } }),
    );
  }

  async upsert(
    tenantId: string,
    id: string | null,
    input: UpsertDataSourceGroupInput,
    actor: Actor = { id: null, type: 'system' },
  ): Promise<DataSourceGroup> {
    const connector = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.findOne(IntegrationConnector, { where: { tenantId, id: input.dataSourceId } }),
    );
    if (!connector) throw new ConnectorNotFoundError(input.dataSourceId);

    const existing = id ? await this.findByIdForTenant(tenantId, id) : null;
    const row = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.save(DataSourceGroup, {
        id: existing?.id ?? randomUUID(),
        tenantId,
        dataSourceId: input.dataSourceId,
        name: input.name,
        description: input.description ?? null,
        type: input.type ?? null,
        avgWorkTimeSeconds: input.avgWorkTimeSeconds ?? null,
      }),
    );

    await this.audit.record({
      tenantId,
      actorId: actor.id ?? '',
      actorType: actor.type,
      action: existing ? 'data_source_group.updated' : 'data_source_group.created',
      resourceType: 'data_source_group',
      resourceId: row.id,
      beforeStateJson: existing ? JSON.stringify(existing) : '',
      afterStateJson: JSON.stringify(row),
      aiRationaleJson: '',
    });

    return row;
  }

  async remove(tenantId: string, id: string, actor: Actor = { id: null, type: 'system' }): Promise<void> {
    const existing = await this.findByIdForTenant(tenantId, id);
    // `data_source_group_queue`'s FK is `ON DELETE CASCADE` - membership
    // rows are removed by Postgres itself, not orchestrated here.
    await withTenantConnection(this.dataSource, tenantId, (manager) => manager.delete(DataSourceGroup, { tenantId, id }));

    await this.audit.record({
      tenantId,
      actorId: actor.id ?? '',
      actorType: actor.type,
      action: 'data_source_group.deleted',
      resourceType: 'data_source_group',
      resourceId: id,
      beforeStateJson: JSON.stringify(existing),
      afterStateJson: '',
      aiRationaleJson: '',
    });
  }

  async addQueue(tenantId: string, groupId: string, ccQueueId: string): Promise<DataSourceGroupQueue> {
    await this.findByIdForTenant(tenantId, groupId);
    const queue = await this.forecasting.findCcQueueById(tenantId, ccQueueId);
    if (!queue) throw new CcQueueNotFoundError(ccQueueId);

    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const existing = await manager.findOne(DataSourceGroupQueue, { where: { tenantId, groupId, ccQueueId } });
      if (existing) return existing;
      return manager.save(DataSourceGroupQueue, { id: randomUUID(), tenantId, groupId, ccQueueId });
    });
  }

  async removeQueue(tenantId: string, groupId: string, ccQueueId: string): Promise<void> {
    await this.findByIdForTenant(tenantId, groupId);
    await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.delete(DataSourceGroupQueue, { tenantId, groupId, ccQueueId }),
    );
  }
}
