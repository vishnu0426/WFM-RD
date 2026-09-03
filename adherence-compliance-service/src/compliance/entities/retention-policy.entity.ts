import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * §5b - a new entity closing the source spec's flagged data-lifecycle gap,
 * not in §2.1's literal list. Same nullable-`tenantId`-is-platform-default
 * shape as `ComplianceRule` (ADR-0095): a null-tenant row is the "stricter
 * known regulatory minimum per jurisdiction where known" default the module
 * prompt calls for, and a tenant-scoped row overrides it. §5b is explicit
 * that this default "needs periodic legal review, it isn't a permanent
 * hardcoded fact" - nothing in this phase seeds any row, platform-default or
 * otherwise; that seeding is a Phase 7 concern alongside the lifecycle job
 * that actually reads this table.
 */
@Entity({ name: 'retention_policy', schema: 'compliance' })
export class RetentionPolicy {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id', nullable: true })
  tenantId!: string | null;

  @Column('varchar', { name: 'jurisdiction' })
  jurisdiction!: string;

  @Column('integer', { name: 'retention_years' })
  retentionYears!: number;

  @Column('jsonb', {
    name: 'applies_to_report_types',
    default: ['adherence_summary', 'overtime_audit', 'rest_period_audit', 'regulator_export'],
  })
  appliesToReportTypes!: string[];

  @Column('timestamptz', { name: 'created_at' })
  createdAt!: Date;
}
