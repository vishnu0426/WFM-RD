import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';
import { DecayJobRunStatus } from './decay-job-run-status.enum';

/**
 * ADR-0017. One row per (tenant, run_date) - the resumability checkpoint
 * for the nightly skill-decay job (§5). `lastProcessedEmployeeId` is the
 * cursor a resumed run continues from; `employeesProcessed`/`failuresCount`
 * accumulate across resume attempts rather than resetting, so they reflect
 * the whole day's run, not just the latest attempt.
 */
@Entity({ schema: 'org', name: 'decay_job_runs' })
@Index('idx_decay_job_runs_tenant_id_status', ['tenantId', 'status'])
export class DecayJobRun {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'date', name: 'run_date' })
  runDate!: string;

  @Column({ type: 'varchar', length: 20, default: DecayJobRunStatus.RUNNING })
  status!: DecayJobRunStatus;

  @Column({ type: 'timestamptz', name: 'started_at' })
  startedAt!: Date;

  @Column({ type: 'timestamptz', name: 'completed_at', nullable: true })
  completedAt!: Date | null;

  @Column({ type: 'uuid', name: 'last_processed_employee_id', nullable: true })
  lastProcessedEmployeeId!: string | null;

  @Column({ type: 'int', name: 'employees_processed', default: 0 })
  employeesProcessed!: number;

  @Column({ type: 'int', name: 'failures_count', default: 0 })
  failuresCount!: number;
}
