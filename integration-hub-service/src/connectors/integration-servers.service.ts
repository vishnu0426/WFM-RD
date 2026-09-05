import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { withTenantConnection } from '../database/with-tenant-connection';
import { IntegrationServer, IntegrationServerRole } from '../integrations/entities/integration-server.entity';
import { IntegrationConnectorServer } from '../integrations/entities/integration-connector-server.entity';
import { IntegrationConnector } from '../integrations/entities/integration-connector.entity';
import { ConnectorNotFoundError } from './errors/connector-not-found.error';
import { IntegrationServerNotFoundError } from './errors/integration-server-not-found.error';
import { AuditGrpcClientService } from '../grpc/audit-grpc-client.service';
import { Actor } from './integration-connectors.service';

export interface UpsertIntegrationServerInput {
  name: string;
  description?: string | null;
  serverName: string;
  portNumber?: number | null;
  httpsPortNumber?: number | null;
  httpAlias?: string | null;
  blocked?: boolean;
  roles: IntegrationServerRole[];
}

/**
 * Integration Servers - a real, persisted inventory (see
 * `IntegrationServer`'s own doc comment: this is a documentation/system-of-
 * record capability, not a control plane - nothing here opens a live
 * connection to a registered server).
 */
@Injectable()
export class IntegrationServersService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditGrpcClientService,
  ) {}

  async findAllForTenant(tenantId: string): Promise<IntegrationServer[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.getRepository(IntegrationServer).find({ where: { tenantId }, order: { name: 'ASC' } }),
    );
  }

  async findByIdForTenant(tenantId: string, id: string): Promise<IntegrationServer> {
    const row = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.findOne(IntegrationServer, { where: { tenantId, id } }),
    );
    if (!row) throw new IntegrationServerNotFoundError(id);
    return row;
  }

  async serversForConnector(tenantId: string, connectorId: string): Promise<IntegrationConnectorServer[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.getRepository(IntegrationConnectorServer).find({ where: { tenantId, connectorId }, order: { createdAt: 'ASC' } }),
    );
  }

  async upsert(
    tenantId: string,
    id: string | null,
    input: UpsertIntegrationServerInput,
    actor: Actor = { id: null, type: 'system' },
  ): Promise<IntegrationServer> {
    const existing = id ? await this.findByIdForTenant(tenantId, id) : null;
    const row = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.save(IntegrationServer, {
        id: existing?.id ?? randomUUID(),
        tenantId,
        name: input.name,
        description: input.description ?? null,
        serverName: input.serverName,
        portNumber: input.portNumber ?? null,
        httpsPortNumber: input.httpsPortNumber ?? null,
        httpAlias: input.httpAlias ?? null,
        blocked: input.blocked ?? false,
        roles: input.roles,
      }),
    );

    await this.audit.record({
      tenantId,
      actorId: actor.id ?? '',
      actorType: actor.type,
      action: existing ? 'integration_server.updated' : 'integration_server.created',
      resourceType: 'integration_server',
      resourceId: row.id,
      beforeStateJson: existing ? JSON.stringify(existing) : '',
      afterStateJson: JSON.stringify(row),
      aiRationaleJson: '',
    });

    return row;
  }

  async remove(tenantId: string, id: string, actor: Actor = { id: null, type: 'system' }): Promise<void> {
    const existing = await this.findByIdForTenant(tenantId, id);
    // `integration_connector_server`'s FK to this table is `ON DELETE
    // CASCADE` - association rows are removed by Postgres itself.
    await withTenantConnection(this.dataSource, tenantId, (manager) => manager.delete(IntegrationServer, { tenantId, id }));

    await this.audit.record({
      tenantId,
      actorId: actor.id ?? '',
      actorType: actor.type,
      action: 'integration_server.deleted',
      resourceType: 'integration_server',
      resourceId: id,
      beforeStateJson: JSON.stringify(existing),
      afterStateJson: '',
      aiRationaleJson: '',
    });
  }

  async associate(tenantId: string, connectorId: string, serverId: string): Promise<IntegrationConnectorServer> {
    const connector = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.findOne(IntegrationConnector, { where: { tenantId, id: connectorId } }),
    );
    if (!connector) throw new ConnectorNotFoundError(connectorId);
    await this.findByIdForTenant(tenantId, serverId);

    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const existing = await manager.findOne(IntegrationConnectorServer, { where: { tenantId, connectorId, serverId } });
      if (existing) return existing;
      return manager.save(IntegrationConnectorServer, { id: randomUUID(), tenantId, connectorId, serverId });
    });
  }

  async disassociate(tenantId: string, connectorId: string, serverId: string): Promise<void> {
    await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.delete(IntegrationConnectorServer, { tenantId, connectorId, serverId }),
    );
  }
}
