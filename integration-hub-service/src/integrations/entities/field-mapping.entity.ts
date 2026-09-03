import { Column, Entity, PrimaryColumn } from 'typeorm';

export enum FieldMappingAuthority {
  SOURCE_AUTHORITATIVE = 'source_authoritative',
  AGNO_AUTHORITATIVE = 'agno_authoritative',
  MANUAL_REVIEW = 'manual_review',
}

/**
 * §2.2 rule 5: `authority` is meaningful for connector_type
 * hris|payroll|crm only - deliberately nullable, never defaulted, so an acd
 * connector's mappings carry no value here rather than a default this
 * module would have to special-case away later.
 */
@Entity({ name: 'field_mapping', schema: 'integration_hub' })
export class FieldMapping {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'connector_id' })
  connectorId!: string;

  @Column('varchar', { name: 'source_field' })
  sourceField!: string;

  @Column('varchar', { name: 'target_field' })
  targetField!: string;

  @Column('jsonb', { name: 'transformation_rule', nullable: true })
  transformationRule!: Record<string, unknown> | null;

  @Column('varchar', { nullable: true })
  authority!: FieldMappingAuthority | null;
}
