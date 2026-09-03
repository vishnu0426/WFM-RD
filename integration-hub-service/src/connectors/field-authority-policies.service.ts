import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { withTenantConnection } from '../database/with-tenant-connection';
import {
  FieldAuthorityPolicy,
  FieldAuthoritySource,
  FieldConflictAction,
} from '../integrations/entities/field-authority-policy.entity';
import { IntegrationConnector } from '../integrations/entities/integration-connector.entity';
import { isStreamingConnectorType } from '../integrations/connector-type.utils';
import { ConnectorNotFoundError } from './errors/connector-not-found.error';
import { FieldAuthorityPolicyNotApplicableError } from './errors/field-authority-policy-not-applicable.error';

export interface UpsertFieldAuthorityPolicyInput {
  connectorId: string;
  fieldName: string;
  authoritativeSource: FieldAuthoritySource;
  conflictAction: FieldConflictAction;
}

/**
 * §3.1's `createFieldAuthorityPolicy` - an upsert keyed by the
 * `(connector_id, field_name)` unique constraint from Phase 1's own
 * migration, the same parity decision `FieldMappingsService.upsert` made:
 * without this, a tenant admin who wants to change a misconfigured
 * `conflict_action` would have no mutation to do it with, since §3 names no
 * separate `updateFieldAuthorityPolicy`.
 */
@Injectable()
export class FieldAuthorityPoliciesService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async upsert(tenantId: string, input: UpsertFieldAuthorityPolicyInput): Promise<FieldAuthorityPolicy> {
    return withTenantConnection(this.dataSource, tenantId, async (manager) => {
      const connector = await manager.findOne(IntegrationConnector, {
        where: { tenantId, id: input.connectorId },
      });
      if (!connector) {
        throw new ConnectorNotFoundError(input.connectorId);
      }
      // §2.2 rule 5: scope is hris|payroll|crm only - structurally
      // rejected here for acd, not silently accepted with nothing to ever
      // detect a conflict against.
      if (isStreamingConnectorType(connector.connectorType)) {
        throw new FieldAuthorityPolicyNotApplicableError();
      }

      const existing = await manager.findOne(FieldAuthorityPolicy, {
        where: { tenantId, connectorId: input.connectorId, fieldName: input.fieldName },
      });

      return manager.save(FieldAuthorityPolicy, {
        id: existing?.id ?? randomUUID(),
        tenantId,
        connectorId: input.connectorId,
        fieldName: input.fieldName,
        authoritativeSource: input.authoritativeSource,
        conflictAction: input.conflictAction,
      });
    });
  }

  async findAllForConnector(tenantId: string, connectorId: string): Promise<FieldAuthorityPolicy[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager
        .getRepository(FieldAuthorityPolicy)
        .find({ where: { tenantId, connectorId }, order: { fieldName: 'ASC' } }),
    );
  }
}
