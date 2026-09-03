import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantScopedRepository } from '../../../common/tenant/tenant-scoped.repository';
import { withTenantTransaction } from '../../../common/tenant/with-tenant-transaction';
import { DecayJobRun } from '../entities/decay-job-run.entity';
import { DecayJobRunStatus } from '../entities/decay-job-run-status.enum';

@Injectable()
export class DecayJobRunsRepository extends TenantScopedRepository<DecayJobRun> {
  constructor(dataSource: DataSource, tenantContext: TenantContextService) {
    super(dataSource, DecayJobRun, tenantContext);
  }

  async findForDate(runDate: string): Promise<DecayJobRun | null> {
    return this.findOne({ where: { runDate } as never });
  }

  async createRunning(runDate: string): Promise<DecayJobRun> {
    return this.save({
      runDate,
      status: DecayJobRunStatus.RUNNING,
      startedAt: new Date(),
      completedAt: null,
      lastProcessedEmployeeId: null,
      employeesProcessed: 0,
      failuresCount: 0,
    } as DecayJobRun);
  }

  /** Marks a previously failed/interrupted run as running again for a resume attempt. */
  async markRunning(id: string): Promise<void> {
    await this.update({ id } as never, { status: DecayJobRunStatus.RUNNING } as never);
  }

  async recordProgress(
    id: string,
    lastProcessedEmployeeId: string,
    batchProcessed: number,
    batchFailures: number,
  ): Promise<void> {
    const tenantId = this.tenantContext.requireTenantId();
    const isPlatformAdmin = this.tenantContext.isPlatformAdmin();
    await withTenantTransaction(this.dataSource, { tenantId, isPlatformAdmin }, (manager) =>
      manager.query(
        `UPDATE org.decay_job_runs
         SET last_processed_employee_id = $1, employees_processed = employees_processed + $2, failures_count = failures_count + $3
         WHERE tenant_id = $4 AND id = $5`,
        [lastProcessedEmployeeId, batchProcessed, batchFailures, tenantId, id],
      ),
    );
  }

  async markCompleted(id: string): Promise<void> {
    await this.update({ id } as never, { status: DecayJobRunStatus.COMPLETED, completedAt: new Date() } as never);
  }

  async markFailed(id: string): Promise<void> {
    await this.update({ id } as never, { status: DecayJobRunStatus.FAILED } as never);
  }
}
