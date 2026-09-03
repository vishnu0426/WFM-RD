import { Entity, PrimaryColumn, Column, Index } from 'typeorm';
import { OrgUnitType } from './org-unit-type.enum';
import { OrgUnitStatus } from './org-unit-status.enum';

/**
 * ADR-0009 (SCD Type 2). One row per version of an `OrgUnit`, written by the
 * `org.fn_org_unit_history_track` trigger (Phase 1 migration) on every
 * INSERT and on any UPDATE that changes a tracked column
 * (`parent_org_unit_id`, `type`, `name`, `timezone`, `country_code`,
 * `status`) - never by application code. `agno_app` has INSERT + a
 * column-scoped `UPDATE (valid_to)` grant only (closing out the prior open
 * row), no DELETE - see the migration's GRANT statements.
 *
 * `orgHierarchy(rootId, asOfDate)` reconstructs a past hierarchy by walking
 * `parentOrgUnitId` here via a recursive CTE for rows where
 * `validFrom <= asOfDate < validTo` (or `validTo IS NULL`) - not via the live
 * table's `path` column, which only ever reflects the *current* tree.
 */
@Entity({ schema: 'org', name: 'org_unit_history' })
@Index('idx_org_unit_history_tenant_id_org_unit_id', ['tenantId', 'orgUnitId', 'validFrom'])
export class OrgUnitHistory {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'org_unit_id' })
  orgUnitId!: string;

  @Column({ type: 'timestamptz', name: 'valid_from' })
  validFrom!: Date;

  /** NULL = this is the currently active version. */
  @Column({ type: 'timestamptz', name: 'valid_to', nullable: true })
  validTo!: Date | null;

  @Column({ type: 'uuid', name: 'parent_org_unit_id', nullable: true })
  parentOrgUnitId!: string | null;

  @Column({ type: 'varchar', length: 20 })
  type!: OrgUnitType;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 50 })
  timezone!: string;

  @Column({ type: 'varchar', length: 2, name: 'country_code' })
  countryCode!: string;

  @Column({ type: 'varchar', length: 20 })
  status!: OrgUnitStatus;
}
