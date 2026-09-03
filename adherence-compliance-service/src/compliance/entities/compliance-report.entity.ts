import { Column, Entity, PrimaryColumn } from 'typeorm';

export enum ComplianceReportType {
  ADHERENCE_SUMMARY = 'adherence_summary',
  OVERTIME_AUDIT = 'overtime_audit',
  REST_PERIOD_AUDIT = 'rest_period_audit',
  REGULATOR_EXPORT = 'regulator_export',
}

export enum ComplianceReportStatus {
  PENDING = 'pending',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

/**
 * §2.1, §5b. `status` is added beyond the source spec's literal field list -
 * `generateComplianceReport`/`POST /v1/compliance/reports` (§3.2) is
 * explicitly async (returns a `job_id`), so this table needs to represent
 * "accepted, file not ready yet" distinctly from "generation failed,"
 * neither of which a bare `fileUri` column can express on its own.
 * `retentionExpiresAt` is `NOT NULL` at the schema level (§5b: "not left
 * null, not assumed indefinite") even though nothing computes it until
 * Phase 6/7 - the column exists now so that guarantee is structural from the
 * table's first row, not bolted on once report generation is real.
 * `legalHold` is the lifecycle job's (Phase 7) override: true blocks the job
 * from acting on this row regardless of `retentionExpiresAt`.
 */
@Entity({ name: 'compliance_report', schema: 'compliance' })
export class ComplianceReport {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('varchar', { name: 'report_type' })
  reportType!: ComplianceReportType;

  @Column('date', { name: 'date_range_start' })
  dateRangeStart!: string;

  @Column('date', { name: 'date_range_end' })
  dateRangeEnd!: string;

  @Column('uuid', { name: 'org_unit_scope', nullable: true })
  orgUnitScope!: string | null;

  @Column('varchar', { name: 'status', default: ComplianceReportStatus.PENDING })
  status!: ComplianceReportStatus;

  @Column('timestamptz', { name: 'generated_at' })
  generatedAt!: Date;

  @Column('uuid', { name: 'generated_by' })
  generatedBy!: string;

  @Column('text', { name: 'file_uri', nullable: true })
  fileUri!: string | null;

  @Column('timestamptz', { name: 'retention_expires_at' })
  retentionExpiresAt!: Date;

  @Column('boolean', { name: 'legal_hold', default: false })
  legalHold!: boolean;
}
