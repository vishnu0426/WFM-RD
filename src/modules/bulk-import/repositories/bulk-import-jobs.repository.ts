import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { TenantScopedRepository } from '../../../common/tenant/tenant-scoped.repository';
import { BulkImportJob } from '../entities/bulk-import-job.entity';
import { BulkImportJobStatus } from '../entities/bulk-import-job-status.enum';

@Injectable()
export class BulkImportJobsRepository extends TenantScopedRepository<BulkImportJob> {
  constructor(dataSource: DataSource, tenantContext: TenantContextService) {
    super(dataSource, BulkImportJob, tenantContext);
  }

  async findById(id: string): Promise<BulkImportJob | null> {
    return this.findOne({ where: { id } as never });
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<BulkImportJob | null> {
    return this.findOne({ where: { idempotencyKey } as never });
  }

  async create(dryRun: boolean, totalRecords: number, idempotencyKey: string | null): Promise<BulkImportJob> {
    return this.save({
      id: uuidv4(),
      idempotencyKey,
      status: BulkImportJobStatus.PENDING,
      dryRun,
      totalRecords,
      result: null,
      error: null,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
    } as BulkImportJob);
  }

  async markRunning(id: string): Promise<void> {
    await this.update({ id } as never, { status: BulkImportJobStatus.RUNNING, startedAt: new Date() } as never);
  }

  async markCompleted(id: string, result: Record<string, unknown>): Promise<void> {
    await this.update(
      { id } as never,
      { status: BulkImportJobStatus.COMPLETED, result, completedAt: new Date() } as never,
    );
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.update({ id } as never, { status: BulkImportJobStatus.FAILED, error, completedAt: new Date() } as never);
  }
}
