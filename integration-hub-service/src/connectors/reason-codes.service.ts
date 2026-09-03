import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { withTenantConnection } from '../database/with-tenant-connection';
import { ReasonCode } from '../integrations/entities/reason-code.entity';
import { IntegrationConnector } from '../integrations/entities/integration-connector.entity';
import { ConnectorNotFoundError } from './errors/connector-not-found.error';
import { ReasonCodeNotFoundError } from './errors/reason-code-not-found.error';
import { FieldMappingsService } from './field-mappings.service';
import { DEFAULT_REASON_CODE_SOURCE_FIELD } from './config-schemas';
import { AuditGrpcClientService } from '../grpc/audit-grpc-client.service';
import { Actor } from './integration-connectors.service';

export interface UpsertReasonCodeInput {
  connectorId: string;
  externalId: string;
  reasonCode: string;
  eventMode?: string | null;
  eventReason?: string | null;
  shiftOperation: string;
  origin?: string | null;
}

/**
 * Tenant Admin Integration Management, WP3 (plan decision #5). The table
 * itself is descriptive/master-data; `upsertFieldMapping`/`removeFromFieldMapping`
 * are what make a reason code functionally real - every saved/deleted
 * `ReasonCode` keeps the connector's `FieldMapping` `valueMap` (the
 * mechanism real adapters already consume, e.g. `genesys-cloud.adapter.ts`)
 * in sync, so this table is never just a decorative lookup nobody reads.
 */
@Injectable()
export class ReasonCodesService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly fieldMappings: FieldMappingsService,
    private readonly audit: AuditGrpcClientService,
  ) {}

  async findAllForConnector(tenantId: string, connectorId: string): Promise<ReasonCode[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.getRepository(ReasonCode).find({ where: { tenantId, connectorId }, order: { externalId: 'ASC' } }),
    );
  }

  async findByIdForTenant(tenantId: string, id: string): Promise<ReasonCode> {
    const row = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.findOne(ReasonCode, { where: { tenantId, id } }),
    );
    if (!row) throw new ReasonCodeNotFoundError(id);
    return row;
  }

  async upsert(
    tenantId: string,
    id: string | null,
    input: UpsertReasonCodeInput,
    actor: Actor = { id: null, type: 'system' },
  ): Promise<ReasonCode> {
    const connector = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.findOne(IntegrationConnector, { where: { tenantId, id: input.connectorId } }),
    );
    if (!connector) throw new ConnectorNotFoundError(input.connectorId);

    const existing = id ? await this.findByIdForTenant(tenantId, id) : null;
    const row = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.save(ReasonCode, {
        id: existing?.id ?? randomUUID(),
        tenantId,
        connectorId: input.connectorId,
        externalId: input.externalId,
        reasonCode: input.reasonCode,
        eventMode: input.eventMode ?? null,
        eventReason: input.eventReason ?? null,
        shiftOperation: input.shiftOperation,
        origin: input.origin ?? null,
      }),
    );

    await this.syncFieldMapping(tenantId, connector, row.externalId, row.shiftOperation);

    await this.audit.record({
      tenantId,
      actorId: actor.id ?? '',
      actorType: actor.type,
      action: existing ? 'reason_code.updated' : 'reason_code.created',
      resourceType: 'reason_code',
      resourceId: row.id,
      beforeStateJson: existing ? JSON.stringify(existing) : '',
      afterStateJson: JSON.stringify(row),
      aiRationaleJson: '',
    });

    return row;
  }

  async remove(tenantId: string, id: string, actor: Actor = { id: null, type: 'system' }): Promise<void> {
    const existing = await this.findByIdForTenant(tenantId, id);
    await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.delete(ReasonCode, { tenantId, id }),
    );

    const connector = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.findOne(IntegrationConnector, { where: { tenantId, id: existing.connectorId } }),
    );
    if (connector) {
      await this.removeFromFieldMapping(tenantId, connector, existing.externalId);
    }

    await this.audit.record({
      tenantId,
      actorId: actor.id ?? '',
      actorType: actor.type,
      action: 'reason_code.deleted',
      resourceType: 'reason_code',
      resourceId: id,
      beforeStateJson: JSON.stringify(existing),
      afterStateJson: '',
      aiRationaleJson: '',
    });
  }

  private sourceFieldFor(connector: IntegrationConnector): string {
    const settings = (connector.config as Record<string, unknown>).settings as Record<string, unknown> | undefined;
    return (settings?.reasonCodeSourceField as string | undefined) ?? DEFAULT_REASON_CODE_SOURCE_FIELD;
  }

  private async syncFieldMapping(
    tenantId: string,
    connector: IntegrationConnector,
    externalId: string,
    shiftOperation: string,
  ): Promise<void> {
    const sourceField = this.sourceFieldFor(connector);
    const existingMapping = await this.fieldMappings.findBySourceField(tenantId, connector.id, sourceField);
    const valueMap = { ...((existingMapping?.transformationRule as Record<string, unknown> | undefined)?.valueMap as Record<string, string> | undefined), [externalId]: shiftOperation };
    await this.fieldMappings.upsert(tenantId, {
      connectorId: connector.id,
      sourceField,
      targetField: 'currentActivity',
      transformationRule: { valueMap },
    });
  }

  private async removeFromFieldMapping(tenantId: string, connector: IntegrationConnector, externalId: string): Promise<void> {
    const sourceField = this.sourceFieldFor(connector);
    const existingMapping = await this.fieldMappings.findBySourceField(tenantId, connector.id, sourceField);
    if (!existingMapping) return;
    const valueMap = { ...((existingMapping.transformationRule as Record<string, unknown> | undefined)?.valueMap as Record<string, string> | undefined) };
    delete valueMap[externalId];
    await this.fieldMappings.upsert(tenantId, {
      connectorId: connector.id,
      sourceField,
      targetField: 'currentActivity',
      transformationRule: { valueMap },
    });
  }
}
