import { Injectable, Logger } from '@nestjs/common';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { DecayJobRunsRepository } from '../repositories/decay-job-runs.repository';
import { EmployeesRepository } from '../../employee/repositories/employees.repository';
import { EmployeeSkillsRepository } from '../repositories/employee-skills.repository';
import { PoliciesRepository } from '../../policy/repositories/policies.repository';
import { PolicyType } from '../../policy/entities/policy-type.enum';
import { EmployeeHistoryRepository } from '../../employee/repositories/employee-history.repository';
import { NotificationService } from '../../notification/services/notification.service';
import { OutboxEventsRepository } from '../../eventing/repositories/outbox-events.repository';
import { SUBJECTS, SkillExpiringPayload } from '../../eventing/subjects';
import { DecayJobRun } from '../entities/decay-job-run.entity';
import { DecayJobRunStatus } from '../entities/decay-job-run-status.enum';

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_HALF_LIFE_DAYS = 180;
const EXPIRY_ALERT_THRESHOLD_DAYS = 30;

export interface RunOptions {
  /** Employees per batch/checkpoint (ADR-0017). Overridable for tests that need to force multiple resumable batches deterministically. */
  batchSize?: number;
  /** Stop after this many batches, leaving the run `running` rather than `completed` - test-only hook to simulate a crash mid-run. */
  maxBatches?: number;
}

/**
 * §5's nightly skill-decay job, orchestration layer. Scheduling (which
 * tenant, when) is `SkillDecaySchedulerService`'s job; this class is the
 * per-tenant, resumable unit of work it calls - see ADR-0017 for the
 * checkpoint/resumability design and the decay formula.
 */
@Injectable()
export class SkillDecayJobService {
  private readonly logger = new Logger(SkillDecayJobService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly decayJobRunsRepository: DecayJobRunsRepository,
    private readonly employeesRepository: EmployeesRepository,
    private readonly employeeSkillsRepository: EmployeeSkillsRepository,
    private readonly policiesRepository: PoliciesRepository,
    private readonly employeeHistoryRepository: EmployeeHistoryRepository,
    private readonly notificationService: NotificationService,
    private readonly outboxEventsRepository: OutboxEventsRepository,
  ) {}

  /**
   * Idempotent: a `completed` run for `runDate` is a no-op. Resumable: a
   * `running`/`failed` run for `runDate` continues from
   * `lastProcessedEmployeeId` rather than restarting - safe to call
   * repeatedly (e.g. the scheduler retrying after a crash) without
   * reprocessing already-decayed employees or double-counting
   * `employeesProcessed`.
   */
  async runForTenant(tenantId: string, runDate: string, options: RunOptions = {}): Promise<DecayJobRun> {
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    return this.tenantContext.run({ tenantId }, async () => {
      let run = await this.decayJobRunsRepository.findForDate(runDate);
      if (run?.status === DecayJobRunStatus.COMPLETED) {
        this.logger.log(`Decay job for tenant=${tenantId} date=${runDate} already completed - skipping.`);
        return run;
      }
      if (run) {
        await this.decayJobRunsRepository.markRunning(run.id);
      } else {
        run = await this.decayJobRunsRepository.createRunning(runDate);
      }

      const halfLifeDays = await this.resolveHalfLifeDays();
      let cursor = run.lastProcessedEmployeeId;
      let batchesRun = 0;

      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          if (options.maxBatches !== undefined && batchesRun >= options.maxBatches) {
            this.logger.warn(
              `Decay job for tenant=${tenantId} date=${runDate} stopping after ${batchesRun} batches (maxBatches test hook) - left running for a resume.`,
            );
            return this.decayJobRunsRepository.findForDate(runDate) as Promise<DecayJobRun>;
          }

          const employeeIds = await this.employeesRepository.findIdsPage(cursor, batchSize);
          if (employeeIds.length === 0) {
            break;
          }

          let batchFailures = 0;
          try {
            await this.employeeSkillsRepository.applyDecayForEmployees(employeeIds, halfLifeDays);
          } catch (err) {
            batchFailures = employeeIds.length;
            this.logger.error(
              `Decay batch failed for tenant=${tenantId} date=${runDate} (${employeeIds.length} employees): ${(err as Error).message}`,
            );
          }

          cursor = employeeIds[employeeIds.length - 1];
          await this.decayJobRunsRepository.recordProgress(run.id, cursor, employeeIds.length, batchFailures);
          batchesRun += 1;
        }

        await this.decayJobRunsRepository.markCompleted(run.id);
        await this.logExpiringCertificationAlerts();
        this.logger.log(`Decay job for tenant=${tenantId} date=${runDate} completed.`);
      } catch (err) {
        await this.decayJobRunsRepository.markFailed(run.id);
        this.logger.error(`Decay job for tenant=${tenantId} date=${runDate} failed: ${(err as Error).message}`);
        throw err;
      }

      return this.decayJobRunsRepository.findForDate(runDate) as Promise<DecayJobRun>;
    });
  }

  private async resolveHalfLifeDays(): Promise<number> {
    const policy = await this.policiesRepository.findActiveByType(PolicyType.SKILL_DECAY_HALF_LIFE, new Date());
    const configured = policy?.definition?.halfLifeDays;
    return typeof configured === 'number' && configured > 0 ? configured : DEFAULT_HALF_LIFE_DAYS;
  }

  /**
   * §5/§4's certification-alert requirement. Two distinct things happen per
   * expiring skill: (1) a real `SkillExpiring` domain event goes on the
   * outbox (ADR-0019) - genuine, consumer-facing eventing, exactly what §4
   * asks for; (2) the expiring employee's manager (if one is on file and
   * has platform access) is notified via `NotificationService.enqueue`
   * (GAP-05 fix, enterprise readiness audit 2026-08-18) - previously this
   * only logged who *would* be notified, since no delivery mechanism
   * existed anywhere in this repo; `NotificationService` now resolves the
   * manager's real `NotificationPreference` rows and enqueues a genuine
   * `notification_delivery` row per enabled channel.
   */
  private async logExpiringCertificationAlerts(): Promise<void> {
    // Unpaginated (unlike the API-facing GET /v1/skills/expiring / skillsExpiringSoon):
    // the job needs the complete set to alert on, not one page of it.
    const expiring = await this.employeeSkillsRepository.findExpiringWithin(EXPIRY_ALERT_THRESHOLD_DAYS, {
      limit: 100000,
      offset: 0,
    });
    for (const skill of expiring) {
      const tenantId = this.tenantContext.requireTenantId();
      const payload: SkillExpiringPayload = {
        employeeId: skill.employeeId,
        tenantId,
        skillId: skill.skillId,
        expiryDate: skill.expiryDate as string,
      };
      await this.outboxEventsRepository.record(
        tenantId,
        SUBJECTS.SKILL_EXPIRING,
        payload as unknown as Record<string, unknown>,
      );

      const history = await this.employeeHistoryRepository.findVersionAsOf(skill.employeeId, new Date());
      const managerId = history?.managerEmployeeId;
      if (!managerId) {
        this.logger.warn(
          `SkillExpiring: employee=${skill.employeeId} skill=${skill.skillId} expiresOn=${skill.expiryDate} - no manager on file to notify.`,
        );
        continue;
      }
      const manager = await this.employeesRepository.findById(managerId);
      if (!manager?.userId) {
        this.logger.warn(
          `SkillExpiring: employee=${skill.employeeId} skill=${skill.skillId} expiresOn=${skill.expiryDate} manager=${managerId} - manager has no platform login to notify.`,
        );
        continue;
      }
      const enqueuedCount = await this.notificationService.enqueue(manager.userId, 'skill_expiring', {
        employeeId: skill.employeeId,
        skillId: skill.skillId,
        expiryDate: skill.expiryDate,
      });
      this.logger.log(
        `SkillExpiring: employee=${skill.employeeId} skill=${skill.skillId} expiresOn=${skill.expiryDate} - ` +
          `enqueued ${enqueuedCount} notification delivery(ies) for manager=${manager.userId}.`,
      );
    }
  }
}
