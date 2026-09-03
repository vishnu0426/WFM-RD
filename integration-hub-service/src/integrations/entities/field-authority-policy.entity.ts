import { Column, Entity, PrimaryColumn } from 'typeorm';

export enum FieldAuthoritySource {
  EXTERNAL_SYSTEM = 'external_system',
  AGNO_WFM = 'agno_wfm',
}

export enum FieldConflictAction {
  OVERWRITE = 'overwrite',
  FLAG_FOR_REVIEW = 'flag_for_review',
  REJECT_SYNC = 'reject_sync',
}

/**
 * §2.1/§2.2 rule 5/§5b: scope is connector_type hris|payroll|crm only - a
 * row for an `acd` connector is rejected at the `createFieldAuthorityPolicy`
 * mutation (Phase 4), not something this schema can enforce with a `CHECK`
 * (that would require reading `integration_connector.connector_type` across
 * a constraint, which Postgres `CHECK` cannot do).
 */
@Entity({ name: 'field_authority_policy', schema: 'integration_hub' })
export class FieldAuthorityPolicy {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'connector_id' })
  connectorId!: string;

  @Column('varchar', { name: 'field_name' })
  fieldName!: string;

  @Column('varchar', { name: 'authoritative_source' })
  authoritativeSource!: FieldAuthoritySource;

  @Column('varchar', { name: 'conflict_action' })
  conflictAction!: FieldConflictAction;
}
