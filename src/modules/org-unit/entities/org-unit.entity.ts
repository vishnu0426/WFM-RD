import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { OrgUnitType } from './org-unit-type.enum';
import { OrgUnitStatus } from './org-unit-status.enum';

/**
 * ADR-0008: subtree reads (Scheduling's hot-path `GetSchedulableEmployees`
 * filters by org unit subtree) are served by a materialized path (`path
 * ltree`, GiST-indexed) maintained entirely by DB triggers in the Phase 1
 * migration - never written by application code, so it is deliberately not
 * mapped as a TypeORM column here (same reasoning as `AuditLog`'s partition
 * key not being decorator-representable). Point-in-time hierarchy
 * reconstruction (`orgHierarchy(rootId, asOfDate)`) instead walks
 * `OrgUnitHistory.parentOrgUnitId` via a recursive CTE - see that entity's
 * doc comment for why the two mechanisms deliberately diverge.
 */
@Entity({ schema: 'org', name: 'org_units' })
@Index('idx_org_units_tenant_id_parent_org_unit_id', ['tenantId', 'parentOrgUnitId'])
@Index('idx_org_units_tenant_id_status', ['tenantId', 'status'])
export class OrgUnit {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'parent_org_unit_id', nullable: true })
  parentOrgUnitId!: string | null;

  @ManyToOne(() => OrgUnit, { nullable: true })
  @JoinColumn({ name: 'parent_org_unit_id' })
  parentOrgUnit?: OrgUnit | null;

  @Column({ type: 'varchar', length: 20 })
  type!: OrgUnitType;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 50 })
  timezone!: string;

  @Column({ type: 'varchar', length: 2, name: 'country_code' })
  countryCode!: string;

  @Column({ type: 'varchar', length: 20, default: OrgUnitStatus.ACTIVE })
  status!: OrgUnitStatus;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
