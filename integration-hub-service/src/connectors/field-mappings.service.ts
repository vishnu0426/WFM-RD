import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { withTenantConnection } from '../database/with-tenant-connection';
import { FieldMapping, FieldMappingAuthority } from '../integrations/entities/field-mapping.entity';
import { IntegrationConnector } from '../integrations/entities/integration-connector.entity';
import { isStreamingConnectorType } from '../integrations/connector-type.utils';
import { ConnectorNotFoundError } from './errors/connector-not-found.error';
import { FieldMappingAuthorityNotApplicableError } from './errors/field-mapping-authority-not-applicable.error';

export interface UpsertFieldMappingInput {
  connectorId: string;
  sourceField: string;
  targetField: string;
  transformationRule?: Record<string, unknown> | null;
  authority?: FieldMappingAuthority | null;
}

/**
 * §3.1's `updateFieldMapping` - no separate `createFieldMapping` mutation
 * is named anywhere in §3, so this is a real upsert keyed by the
 * `(connector_id, source_field)` unique constraint from Phase 1's own
 * migration, not update-only.
 */
@Injectable()
export class FieldMappingsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async upsert(tenantId: string, input: UpsertFieldMappingInput): Promise<FieldMapping> {
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const connector = await manager.findOne(IntegrationConnector, {
        where: { tenantId, id: input.connectorId },
      });
      if (!connector) {
        throw new ConnectorNotFoundError(input.connectorId);
      }
      // §2.2 rule 5: authority is meaningful for hris|payroll|crm only -
      // structurally rejected here, not silently accepted and ignored,
      // for an acd connector.
      if (input.authority && isStreamingConnectorType(connector.connectorType)) {
        throw new FieldMappingAuthorityNotApplicableError();
      }

      const existing = await manager.findOne(FieldMapping, {
        where: { tenantId, connectorId: input.connectorId, sourceField: input.sourceField },
      });

      return manager.save(FieldMapping, {
        id: existing?.id ?? randomUUID(),
        tenantId,
        connectorId: input.connectorId,
        sourceField: input.sourceField,
        targetField: input.targetField,
        transformationRule: input.transformationRule ?? null,
        authority: input.authority ?? null,
      });
    });
  }

  async findAllForConnector(tenantId: string, connectorId: string): Promise<FieldMapping[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.getRepository(FieldMapping).find({ where: { tenantId, connectorId }, order: { sourceField: 'ASC' } }),
    );
  }

  /** WP3: `ReasonCodesService`'s own lookup before merging into a `valueMap` - the same `(connector_id, source_field)` unique key `upsert` keys off of. */
  async findBySourceField(tenantId: string, connectorId: string, sourceField: string): Promise<FieldMapping | null> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.getRepository(FieldMapping).findOne({ where: { tenantId, connectorId, sourceField } }),
    );
  }
}
