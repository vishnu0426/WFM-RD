import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';
import { BulkImportJobStatus } from './bulk-import-job-status.enum';

/**
 * §3.2's async job pattern for `POST /v1/employees/bulk-import`. `result`
 * holds either the dry-run diff report (`{ creates, updates, conflicts }`)
 * or the commit summary, depending on `dryRun` - see
 * `BulkImportService`. `idempotencyKey` (§3.2's cross-cutting
 * `Idempotency-Key` requirement) is enforced via a partial unique index
 * (Phase 6 migration), not a CHECK constraint, so repeated requests within
 * the same tenant return the original job rather than starting a second one.
 */
@Entity({ schema: 'org', name: 'bulk_import_jobs' })
@Index('idx_bulk_import_jobs_tenant_id_status', ['tenantId', 'status'])
export class BulkImportJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 255, name: 'idempotency_key', nullable: true })
  idempotencyKey!: string | null;

  @Column({ type: 'varchar', length: 20, default: BulkImportJobStatus.PENDING })
  status!: BulkImportJobStatus;

  @Column({ type: 'boolean', name: 'dry_run', default: false })
  dryRun!: boolean;

  @Column({ type: 'int', name: 'total_records', default: 0 })
  totalRecords!: number;

  @Column({ type: 'jsonb', nullable: true })
  result!: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @Column({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'started_at', nullable: true })
  startedAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'completed_at', nullable: true })
  completedAt!: Date | null;
}
