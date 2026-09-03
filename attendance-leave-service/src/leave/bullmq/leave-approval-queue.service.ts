import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { getNumberConfig } from '../../common/config/get-number-config';

export const LEAVE_APPROVAL_REMINDERS_QUEUE = 'leave-approval-reminders';

export interface LeaveApprovalReminderJobData {
  tenantId: string;
  leaveRequestId: string;
  approvalChainId: string;
}

/**
 * §1/ADR-0077: this service's only Redis presence, and BullMQ's only job
 * responsibility - a delayed "is this decision still pending" check, never
 * the system of record for the decision itself (that's `LeaveRequest.status`
 * in Postgres, always). `jobId: leaveRequestId` makes the job deterministic
 * per request: at most one reminder job can ever exist for a given
 * `LeaveRequest`, and `cancelReminder` is a direct lookup, not a search.
 *
 * Deliberately best-effort, not transactional with the Postgres write that
 * triggers it (`LeaveRequestService.requestLeave`/`DecideLeaveRequestService.decide`
 * both call this *after* their own transaction commits) - see those
 * classes' own doc comments for why a dual-write-consistency mechanism
 * isn't needed here: the worker (`LeaveApprovalReminderWorker`) re-checks
 * `LeaveRequest.status` itself before doing anything, so a missed cancel or
 * a missed enqueue degrades to "one fewer/one stale reminder," never a
 * wrong decision.
 */
@Injectable()
export class LeaveApprovalQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(LeaveApprovalQueueService.name);
  private readonly queue: Queue<LeaveApprovalReminderJobData>;

  constructor(private readonly config: ConfigService) {
    this.queue = new Queue<LeaveApprovalReminderJobData>(LEAVE_APPROVAL_REMINDERS_QUEUE, {
      connection: {
        host: this.config.get<string>('REDIS_HOST', 'localhost'),
        port: getNumberConfig(this.config, 'REDIS_PORT', 6379),
        password: this.config.get<string>('REDIS_PASSWORD') || undefined,
      },
    });
  }

  async scheduleReminder(data: LeaveApprovalReminderJobData, delayMs: number): Promise<void> {
    try {
      await this.queue.add('reminder', data, {
        jobId: data.leaveRequestId,
        delay: delayMs,
        removeOnComplete: true,
        removeOnFail: true,
      });
    } catch (err) {
      // Best-effort (this file's own doc comment) - a missing reminder job
      // means no stale-approval signal fires for this one request, not a
      // wrong decision. Logged, not swallowed silently.
      this.logger.warn(`Failed to schedule approval reminder for leave request ${data.leaveRequestId}: ${String(err)}`);
    }
  }

  async cancelReminder(leaveRequestId: string): Promise<void> {
    try {
      const job = await this.queue.getJob(leaveRequestId);
      if (job) {
        await job.remove();
      }
    } catch (err) {
      // Same best-effort posture - the worker's own status re-check is the
      // real safety net if this fails (LeaveApprovalReminderWorker's doc
      // comment).
      this.logger.warn(`Failed to cancel approval reminder for leave request ${leaveRequestId}: ${String(err)}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
