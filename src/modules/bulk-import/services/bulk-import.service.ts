import { Injectable, Logger } from '@nestjs/common';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { BulkImportJobsRepository } from '../repositories/bulk-import-jobs.repository';
import { BulkImportJobNotFoundError } from '../errors/bulk-import-job-not-found.error';
import { FeatureFlagsService, BULK_IMPORT_DESTRUCTIVE_FLAG } from './feature-flags.service';
import { EmployeesRepository } from '../../employee/repositories/employees.repository';
import { EmployeesService } from '../../employee/services/employees.service';
import { OrgUnitsService } from '../../org-unit/services/org-units.service';
import { BulkImportJob } from '../entities/bulk-import-job.entity';
import { BulkImportRecordDto } from '../dto/bulk-import-record.dto';
import { diffEmployeeRecord } from './bulk-import-diff';
import { AuditLogRepository } from '../../audit/repositories/audit-log.repository';
import { AuditActorType } from '../../audit/entities/audit-actor-type.enum';

interface ConflictEntry {
  employeeNumber: string;
  reason: string;
}

interface DiffReport {
  creates: { employeeNumber: string }[];
  updates: { employeeNumber: string; changes: Record<string, unknown> }[];
  conflicts: ConflictEntry[];
  committed?: { created: number; updated: number };
}

/**
 * §3.2/§0.5's bulk HRIS import. `startImport` returns as soon as the job
 * row exists (§3.2's async pattern - `202` + `job_id`, the actual work
 * happens after the response is sent); `processImport` does the real work
 * and is the only thing that ever writes `status`/`result`.
 *
 * GAP-06 fix (enterprise readiness audit, 2026-08-18): a committing (non-
 * dry-run) import now records one `audit_log` entry for the whole job -
 * job-level, not one entry per employee touched. This is the
 * highest-blast-radius write surface in Module 02 ("can touch thousands of
 * employee records in one call," per this class's own doc comment above);
 * a per-row entry would make `audit_log` itself the next scaling problem.
 * A dry-run never mutates anything, so it records nothing.
 */
@Injectable()
export class BulkImportService {
  private readonly logger = new Logger(BulkImportService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly bulkImportJobsRepository: BulkImportJobsRepository,
    private readonly employeesRepository: EmployeesRepository,
    private readonly employeesService: EmployeesService,
    private readonly orgUnitsService: OrgUnitsService,
    private readonly featureFlagsService: FeatureFlagsService,
    private readonly auditLog: AuditLogRepository,
  ) {}

  async findJob(jobId: string): Promise<BulkImportJob> {
    const job = await this.bulkImportJobsRepository.findById(jobId);
    if (!job) {
      throw new BulkImportJobNotFoundError(jobId);
    }
    return job;
  }

  /**
   * `dryRun` defaults to `true` when omitted - §0.5's progressive-delivery
   * requirement ("must ship behind a feature flag with a dry-run mode...
   * before the destructive mode is enabled") reads most naturally as
   * dry-run being the safe default, not something a caller has to
   * remember to opt into.
   */
  async startImport(
    request: { dryRun?: boolean; records: BulkImportRecordDto[] },
    idempotencyKey: string | null,
  ): Promise<BulkImportJob> {
    if (idempotencyKey) {
      const existing = await this.bulkImportJobsRepository.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        return existing;
      }
    }

    const dryRun = request.dryRun ?? true;
    const job = await this.bulkImportJobsRepository.create(dryRun, request.records.length, idempotencyKey);

    const tenantId = this.tenantContext.requireTenantId();
    const actorId = this.tenantContext.getStore()?.actorId ?? null;
    // Deliberately not awaited - see the class doc comment. Errors inside
    // processImport are caught and recorded on the job row itself; this
    // .catch is only a last-resort guard against a bug in that handling.
    this.processImport(job.id, tenantId, actorId, request.records, dryRun).catch((err) => {
      this.logger.error(`Unhandled error processing bulk import job=${job.id}: ${(err as Error).message}`);
    });

    return job;
  }

  private async processImport(
    jobId: string,
    tenantId: string,
    actorId: string | null,
    records: BulkImportRecordDto[],
    dryRun: boolean,
  ): Promise<void> {
    await this.tenantContext.run({ tenantId }, async () => {
      await this.bulkImportJobsRepository.markRunning(jobId);
      try {
        const report = await this.buildReport(records);

        if (dryRun) {
          await this.bulkImportJobsRepository.markCompleted(jobId, report as unknown as Record<string, unknown>);
          return;
        }

        const destructiveEnabled = await this.featureFlagsService.isEnabled(BULK_IMPORT_DESTRUCTIVE_FLAG);
        if (!destructiveEnabled) {
          await this.bulkImportJobsRepository.markFailed(
            jobId,
            `Destructive bulk import is not enabled for this tenant (feature flag "${BULK_IMPORT_DESTRUCTIVE_FLAG}"). Re-run with dryRun: true, or enable the flag first.`,
          );
          return;
        }

        report.committed = await this.commit(records, report);
        await this.bulkImportJobsRepository.markCompleted(jobId, report as unknown as Record<string, unknown>);
        await this.auditLog.record({
          tenantId,
          actorId,
          actorType: AuditActorType.USER,
          action: 'employee.bulk_import.committed',
          resourceType: 'bulk_import_job',
          resourceId: jobId,
          beforeState: null,
          afterState: {
            recordCount: records.length,
            created: report.committed.created,
            updated: report.committed.updated,
            conflicts: report.conflicts.length,
          },
          aiRationale: null,
        });
      } catch (err) {
        await this.bulkImportJobsRepository.markFailed(jobId, (err as Error).message);
        this.logger.error(`Bulk import job=${jobId} failed: ${(err as Error).message}`);
      }
    });
  }

  private async buildReport(records: BulkImportRecordDto[]): Promise<DiffReport> {
    const report: DiffReport = { creates: [], updates: [], conflicts: [] };

    for (const record of records) {
      const orgUnit = await this.orgUnitsService.findById(record.orgUnitId).catch(() => null);
      if (!orgUnit) {
        report.conflicts.push({
          employeeNumber: record.employeeNumber,
          reason: `orgUnitId ${record.orgUnitId} not found`,
        });
        continue;
      }
      if (record.managerEmployeeId) {
        const manager = await this.employeesRepository.findById(record.managerEmployeeId);
        if (!manager) {
          report.conflicts.push({
            employeeNumber: record.employeeNumber,
            reason: `managerEmployeeId ${record.managerEmployeeId} not found`,
          });
          continue;
        }
      }

      const existing = await this.employeesRepository.findByEmployeeNumber(record.employeeNumber);
      if (!existing) {
        report.creates.push({ employeeNumber: record.employeeNumber });
        continue;
      }
      const changes = diffEmployeeRecord(existing, record);
      if (Object.keys(changes).length > 0) {
        report.updates.push({ employeeNumber: record.employeeNumber, changes });
      }
    }

    return report;
  }

  /** Applies only the records the dry-run pass already classified as creates/updates - conflicts are never committed. */
  private async commit(
    records: BulkImportRecordDto[],
    report: DiffReport,
  ): Promise<{ created: number; updated: number }> {
    const conflictNumbers = new Set(report.conflicts.map((c) => c.employeeNumber));
    const updateNumbers = new Set(report.updates.map((u) => u.employeeNumber));
    let created = 0;
    let updated = 0;

    for (const record of records) {
      if (conflictNumbers.has(record.employeeNumber)) {
        continue;
      }
      const existing = await this.employeesRepository.findByEmployeeNumber(record.employeeNumber);
      if (existing) {
        if (!updateNumbers.has(record.employeeNumber)) {
          continue;
        }
        if (
          existing.orgUnitId !== record.orgUnitId ||
          existing.managerEmployeeId !== (record.managerEmployeeId ?? null)
        ) {
          await this.employeesService.transfer(existing.id, record.orgUnitId, record.managerEmployeeId ?? null);
        }
        await this.employeesService.update(existing.id, {
          employmentType: record.employmentType,
          contractHoursPerWeek: record.contractHoursPerWeek,
          costCenter: record.costCenter ?? null,
        });
        updated += 1;
      } else {
        await this.employeesService.create({
          orgUnitId: record.orgUnitId,
          employeeNumber: record.employeeNumber,
          employmentType: record.employmentType,
          contractHoursPerWeek: record.contractHoursPerWeek,
          hireDate: record.hireDate,
          costCenter: record.costCenter ?? null,
          managerEmployeeId: record.managerEmployeeId ?? null,
        });
        created += 1;
      }
    }

    return { created, updated };
  }
}
