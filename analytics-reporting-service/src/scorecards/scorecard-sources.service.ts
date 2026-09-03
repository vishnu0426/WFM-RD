import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, ObjectLiteral } from 'typeorm';
import { randomUUID } from 'crypto';
import { withTenantConnection } from '../database/with-tenant-connection';
import { ScorecardSourceSystem } from './entities/scorecard-source-system.entity';
import { ScorecardSourceMeasure } from './entities/scorecard-source-measure.entity';
import { ScorecardSourceCode } from './entities/scorecard-source-code.entity';
import { ScorecardSourceMapping } from './entities/scorecard-source-mapping.entity';
import { ScorecardDimensionType } from './entities/scorecard-dimension-type.entity';
import { ScorecardDimensionMember } from './entities/scorecard-dimension-member.entity';
import { ScorecardResourceNotFoundError } from './errors/scorecard-resource-not-found.error';
import { AuditGrpcClientService } from '../grpc/audit-grpc-client.service';

export interface Actor {
  id: string | null;
  type: 'user' | 'system';
}
const DEFAULT_ACTOR: Actor = { id: null, type: 'system' };

/**
 * Tenant Admin Integration Management, WP6. One service for all six
 * Scorecards Sources entities (rather than six near-identical service
 * classes) - each entity is a simple tenant-scoped catalog row with the
 * same create/list/update/delete shape, so the repetition a per-entity
 * service would add is pure boilerplate, not real distinctness (contrast
 * with integration-hub-service's WP3 `ReasonCodesService`, which has real,
 * non-generic behavior - the `FieldMapping` sync - `DataSourceGroupsService`
 * doesn't share).
 */
@Injectable()
export class ScorecardSourcesService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditGrpcClientService,
  ) {}

  // ---------------------------------------------------------------------
  // Source Systems
  // ---------------------------------------------------------------------

  async listSourceSystems(tenantId: string): Promise<ScorecardSourceSystem[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.getRepository(ScorecardSourceSystem).find({ where: { tenantId }, order: { name: 'ASC' } }),
    );
  }

  async upsertSourceSystem(
    tenantId: string,
    id: string | null,
    input: { name: string; provider: string; connectorId?: string | null },
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<ScorecardSourceSystem> {
    return this.upsert(
      tenantId,
      ScorecardSourceSystem,
      'ScorecardSourceSystem',
      id,
      { name: input.name, provider: input.provider, connectorId: input.connectorId ?? null },
      actor,
    );
  }

  async deleteSourceSystem(tenantId: string, id: string, actor: Actor = DEFAULT_ACTOR): Promise<void> {
    await this.remove(tenantId, ScorecardSourceSystem, 'ScorecardSourceSystem', id, actor);
  }

  // ---------------------------------------------------------------------
  // Source Measures
  // ---------------------------------------------------------------------

  async listSourceMeasures(tenantId: string, sourceSystemId: string): Promise<ScorecardSourceMeasure[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.getRepository(ScorecardSourceMeasure).find({ where: { tenantId, sourceSystemId }, order: { code: 'ASC' } }),
    );
  }

  async upsertSourceMeasure(
    tenantId: string,
    id: string | null,
    input: { sourceSystemId: string; code: string; name: string; description?: string | null; unit?: string | null },
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<ScorecardSourceMeasure> {
    return this.upsert(tenantId, ScorecardSourceMeasure, 'ScorecardSourceMeasure', id, input, actor);
  }

  async deleteSourceMeasure(tenantId: string, id: string, actor: Actor = DEFAULT_ACTOR): Promise<void> {
    await this.remove(tenantId, ScorecardSourceMeasure, 'ScorecardSourceMeasure', id, actor);
  }

  // ---------------------------------------------------------------------
  // Source Codes
  // ---------------------------------------------------------------------

  async listSourceCodes(tenantId: string, sourceSystemId: string): Promise<ScorecardSourceCode[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.getRepository(ScorecardSourceCode).find({ where: { tenantId, sourceSystemId }, order: { code: 'ASC' } }),
    );
  }

  async upsertSourceCode(
    tenantId: string,
    id: string | null,
    input: { sourceSystemId: string; code: string; description?: string | null },
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<ScorecardSourceCode> {
    return this.upsert(tenantId, ScorecardSourceCode, 'ScorecardSourceCode', id, input, actor);
  }

  async deleteSourceCode(tenantId: string, id: string, actor: Actor = DEFAULT_ACTOR): Promise<void> {
    await this.remove(tenantId, ScorecardSourceCode, 'ScorecardSourceCode', id, actor);
  }

  // ---------------------------------------------------------------------
  // Source Mappings
  // ---------------------------------------------------------------------

  async listSourceMappings(tenantId: string, sourceMeasureId: string): Promise<ScorecardSourceMapping[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.getRepository(ScorecardSourceMapping).find({ where: { tenantId, sourceMeasureId }, order: { targetMetric: 'ASC' } }),
    );
  }

  async upsertSourceMapping(
    tenantId: string,
    id: string | null,
    input: { sourceMeasureId: string; targetMetric: string; description?: string | null },
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<ScorecardSourceMapping> {
    return this.upsert(tenantId, ScorecardSourceMapping, 'ScorecardSourceMapping', id, input, actor);
  }

  async deleteSourceMapping(tenantId: string, id: string, actor: Actor = DEFAULT_ACTOR): Promise<void> {
    await this.remove(tenantId, ScorecardSourceMapping, 'ScorecardSourceMapping', id, actor);
  }

  // ---------------------------------------------------------------------
  // Dimension Types
  // ---------------------------------------------------------------------

  async listDimensionTypes(tenantId: string): Promise<ScorecardDimensionType[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.getRepository(ScorecardDimensionType).find({ where: { tenantId }, order: { name: 'ASC' } }),
    );
  }

  async upsertDimensionType(
    tenantId: string,
    id: string | null,
    input: { name: string; description?: string | null },
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<ScorecardDimensionType> {
    return this.upsert(tenantId, ScorecardDimensionType, 'ScorecardDimensionType', id, input, actor);
  }

  async deleteDimensionType(tenantId: string, id: string, actor: Actor = DEFAULT_ACTOR): Promise<void> {
    await this.remove(tenantId, ScorecardDimensionType, 'ScorecardDimensionType', id, actor);
  }

  // ---------------------------------------------------------------------
  // Dimension Members
  // ---------------------------------------------------------------------

  async listDimensionMembers(tenantId: string, dimensionTypeId: string): Promise<ScorecardDimensionMember[]> {
    return withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.getRepository(ScorecardDimensionMember).find({ where: { tenantId, dimensionTypeId }, order: { code: 'ASC' } }),
    );
  }

  async upsertDimensionMember(
    tenantId: string,
    id: string | null,
    input: { dimensionTypeId: string; code: string; name: string },
    actor: Actor = DEFAULT_ACTOR,
  ): Promise<ScorecardDimensionMember> {
    return this.upsert(tenantId, ScorecardDimensionMember, 'ScorecardDimensionMember', id, input, actor);
  }

  async deleteDimensionMember(tenantId: string, id: string, actor: Actor = DEFAULT_ACTOR): Promise<void> {
    await this.remove(tenantId, ScorecardDimensionMember, 'ScorecardDimensionMember', id, actor);
  }

  // ---------------------------------------------------------------------
  // Shared upsert/remove + audit, generic across all six entities - each
  // is a plain `{ id, tenantId, ...fields }` row with no entity-specific
  // side effects (unlike integration-hub-service's ReasonCode, which
  // genuinely needs its own method to stay readable).
  // ---------------------------------------------------------------------

  private async upsert<T extends ObjectLiteral & { id: string; tenantId: string }>(
    tenantId: string,
    entityClass: new () => T,
    resourceType: string,
    id: string | null,
    fields: Record<string, unknown>,
    actor: Actor,
  ): Promise<T> {
    const existing = id
      ? await withTenantConnection(this.dataSource, tenantId, (manager) => manager.findOne(entityClass, { where: { id, tenantId } as never }))
      : null;
    if (id && !existing) {
      throw new ScorecardResourceNotFoundError(resourceType, id);
    }

    const rowId = existing?.id ?? randomUUID();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row: T = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      (manager as any).save(entityClass, { ...existing, id: rowId, tenantId, ...fields }),
    );

    await this.audit.record({
      tenantId,
      actorId: actor.id ?? '',
      actorType: actor.type,
      action: existing ? `${toSnakeCase(resourceType)}.updated` : `${toSnakeCase(resourceType)}.created`,
      resourceType: toSnakeCase(resourceType),
      resourceId: rowId,
      beforeStateJson: existing ? JSON.stringify(existing) : '',
      afterStateJson: JSON.stringify(row),
      aiRationaleJson: '',
    });

    return row;
  }

  private async remove<T extends ObjectLiteral & { id: string; tenantId: string }>(
    tenantId: string,
    entityClass: new () => T,
    resourceType: string,
    id: string,
    actor: Actor,
  ): Promise<void> {
    const existing = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.findOne(entityClass, { where: { id, tenantId } as never }),
    );
    if (!existing) {
      throw new ScorecardResourceNotFoundError(resourceType, id);
    }
    await withTenantConnection(this.dataSource, tenantId, (manager) => manager.delete(entityClass, { id, tenantId } as never));

    await this.audit.record({
      tenantId,
      actorId: actor.id ?? '',
      actorType: actor.type,
      action: `${toSnakeCase(resourceType)}.deleted`,
      resourceType: toSnakeCase(resourceType),
      resourceId: id,
      beforeStateJson: JSON.stringify(existing),
      afterStateJson: '',
      aiRationaleJson: '',
    });
  }
}

function toSnakeCase(pascalCase: string): string {
  return pascalCase.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}
