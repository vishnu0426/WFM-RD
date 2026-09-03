import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { Job, Worker } from 'bullmq';
import { LeaveRequest, LeaveRequestStatus } from '../entities/leave-request.entity';
import { LEAVE_APPROVAL_REMINDERS_QUEUE, LeaveApprovalReminderJobData } from './leave-approval-queue.service';
import { MetricsService } from '../../common/metrics/metrics.service';
import { withTenantConnection } from '../../database/with-tenant-connection';
import { getNumberConfig } from '../../common/config/get-number-config';

/**
 * §1/ADR-0077: processes `leave-approval-reminders` in-process (no separate
 * worker deployable - §0's "not compute-heavy or high-throughput" framing
 * doesn't justify one). Re-checks `LeaveRequest.status` itself before doing
 * anything: `DecideLeaveRequestService.decide` cancels this job on a timely
 * decision, but that cancel is best-effort, so a job can legitimately fire
 * after the request was already decided (a benign race, not a bug) - this
 * check is what makes that safe rather than acting on stale state.
 *
 * No real notification channel exists in this service (Module 01's
 * `NotificationPreference` isn't integrated - no gRPC/REST client for it
 * exists anywhere in this codebase). This phase's honest scope is a
 * structured log line plus a Prometheus counter an on-call dashboard could
 * actually alert on ("N stale pending approvals") - not a fabricated
 * "notification sent" claim. See the Phase 4 design doc's explicit
 * assumptions for what a real notification integration would need.
 */
@Injectable()
export class LeaveApprovalReminderWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LeaveApprovalReminderWorker.name);
  private worker?: Worker<LeaveApprovalReminderJobData>;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker<LeaveApprovalReminderJobData>(LEAVE_APPROVAL_REMINDERS_QUEUE, (job) => this.process(job), {
      connection: {
        host: this.config.get<string>('REDIS_HOST', 'localhost'),
        port: getNumberConfig(this.config, 'REDIS_PORT', 6379),
        password: this.config.get<string>('REDIS_PASSWORD') || undefined,
      },
    });
    this.worker.on('failed', (job, err) => {
      this.logger.warn(`Approval reminder job ${job?.id ?? '(unknown)'} failed: ${String(err)}`);
    });
  }

  async process(job: Job<LeaveApprovalReminderJobData>): Promise<void> {
    const { tenantId, leaveRequestId } = job.data;
    const stillPending = await withTenantConnection(this.dataSource, tenantId, (manager) =>
      manager.findOneBy(LeaveRequest, { id: leaveRequestId, status: LeaveRequestStatus.PENDING }),
    );
    if (!stillPending) {
      return;
    }

    this.metrics.recordLeaveApprovalReminderFired();
    this.logger.warn(
      `Leave request ${leaveRequestId} (tenant ${tenantId}) has been pending past its reminder threshold.`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
