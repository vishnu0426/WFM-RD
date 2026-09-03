import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { LeaveBalance } from './entities/leave-balance.entity';
import { LeaveRequest, LeaveRequestStatus } from './entities/leave-request.entity';
import { inclusiveDayCount } from './leave-request.service';
import { LeaveApprovalQueueService } from './bullmq/leave-approval-queue.service';
import { DecideLeaveRequestDto } from './dto/decide-leave-request.dto';
import { LeaveRequestNotFoundError } from '../common/errors/leave-request-not-found.error';
import { LeaveRequestAlreadyDecidedError } from '../common/errors/leave-request-already-decided.error';
import { LeaveBalanceNotFoundError } from '../common/errors/leave-balance-not-found.error';
import { InsufficientPermissionError } from '../common/errors/insufficient-permission.error';
import { MetricsService } from '../common/metrics/metrics.service';
import { withTenantConnection } from '../database/with-tenant-connection';
import { AttendanceLeaveNatsClientService } from '../nats/nats-client.service';
import { ATTENDANCE_LEAVE_SUBJECTS, LeaveRequestApprovedPayload } from '../nats/subjects';
import { AuditGrpcClientService } from '../grpc/audit-grpc-client.service';

/** §5.1/ADR-0079: the new, granular Module 01 permission - `backdated_leave_entry` is its own RESOURCES entry (root `src/database/seeds/run-seed.ts`), never the ordinary leave-approver permission. */
export const BACKDATED_LEAVE_APPROVE_PERMISSION = 'backdated_leave_entry:approve';

/**
 * §3.3/ADR-0074's same discipline applied to the decision side:
 * `SELECT ... FOR UPDATE` on both the `LeaveRequest` row (so two concurrent
 * decisions on the same request can't both apply - the request-side
 * equivalent of ADR-0074's balance lock) and its `LeaveBalance` row (the
 * exact same composite-PK lock Phase 3's submission path uses), one
 * transaction. On `approved`, `pending_days` moves to `used_days` (§3.3's
 * own wording). On `rejected`, `pending_days` is released - not explicitly
 * named by §3.3, but a necessary, obvious completion of §2.2 rule 1's
 * model: a rejected request must give back the days it reserved, or
 * `availableDays` would shrink permanently for every rejection, a
 * correctness bug the module prompt's own "resist over-engineering, but
 * this is a correctness-critical module" framing would not excuse.
 *
 * `LeaveApprovalQueueService.cancelReminder` runs *after* this transaction
 * commits, not inside it - a failed cancel doesn't roll back an
 * already-recorded human decision (Postgres stays authoritative); the
 * worker's own status re-check (`LeaveApprovalReminderWorker`) is what
 * makes a missed cancel harmless rather than a stale/wrong reminder.
 *
 * §3.4/ADR-0078: on `approved`, also publishes `agno.leave.request.approved.v1`
 * - the push half of this module's propagation design
 * (`LeaveService.GetUnavailability`, Phase 5's gRPC surface, is the pull
 * half scheduling-service's own solve-input resolver relies on regardless).
 * Same best-effort, after-commit posture as the BullMQ cancel: Postgres
 * stays authoritative, a failed publish means scheduling-service's next
 * solve still sees the approval via the pull path, just not proactively
 * before then.
 *
 * §5.1/ADR-0079 (Phase 6): deciding an `is_backdated` request adds two
 * things, both inside `applyDecision`'s transaction/scope except the
 * audit call itself. First, *approving* one requires
 * `BACKDATED_LEAVE_APPROVE_PERMISSION` in `dto.actorPermissions` - checked
 * before the `LeaveBalance` row is even locked, so a denial never
 * acquires a lock it won't use. Rejecting a backdated request needs no
 * elevated permission (only approval carries the payroll/compliance
 * implication §5.1 calls out). Second, every decided backdated request
 * (approved or rejected) gets an `AuditService.RecordEvent` call after
 * commit - same best-effort, after-commit posture as the NATS publish
 * above (core's own `audit.proto` documents `RecordEvent` as
 * fire-and-forget from the caller's side by design, so this is the
 * *correct* posture here, not a shortcut).
 */
@Injectable()
export class DecideLeaveRequestService {
  private readonly logger = new Logger(DecideLeaveRequestService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly approvalQueue: LeaveApprovalQueueService,
    private readonly natsClient: AttendanceLeaveNatsClientService,
    private readonly auditClient: AuditGrpcClientService,
    private readonly metrics: MetricsService,
  ) {}

  async decide(tenantId: string, leaveRequestId: string, dto: DecideLeaveRequestDto): Promise<LeaveRequest> {
    let result: LeaveRequest;
    try {
      result = await withTenantConnection(this.dataSource, tenantId, (manager) =>
        this.applyDecision(manager, tenantId, leaveRequestId, dto),
      );
      this.metrics.recordLeaveRequestDecision(dto.decision === LeaveRequestStatus.APPROVED ? 'approved' : 'rejected');
    } catch (err) {
      if (err instanceof InsufficientPermissionError) {
        this.metrics.recordBackdatedPermissionDenial();
      }
      this.metrics.recordLeaveRequestDecision(
        err instanceof LeaveRequestNotFoundError || err instanceof LeaveRequestAlreadyDecidedError
          ? 'rejected'
          : 'error',
      );
      throw err;
    }

    await this.approvalQueue.cancelReminder(leaveRequestId);

    if (dto.decision === LeaveRequestStatus.APPROVED) {
      await this.publishApproval(result);
    }

    if (result.isBackdated) {
      await this.auditBackdatedDecision(result, dto);
    }

    return result;
  }

  /**
   * §5.1: "The AuditLog entry for a backdated leave decision must capture
   * the delta this creates against any already-processed attendance/
   * payroll data for that period." No payroll system exists anywhere in
   * this platform (Module 12 is unbuilt) to diff against - there is no
   * "already-processed payroll data" to read. What this records instead is
   * the honest, buildable interpretation: the delta this decision itself
   * creates in this module's own state (pending reservation -> approved/
   * rejected), plus an explicit `payrollResyncRequired` flag on approval -
   * §5.1's own instruction to "flag explicitly ... rather than assuming
   * it's a clean, isolated write," surfaced as data on the audit event
   * itself since there is no Module 12 endpoint to actually call. A future
   * phase adding Module 12 integration should treat this flag as its
   * trigger condition, not re-derive it.
   */
  private async auditBackdatedDecision(request: LeaveRequest, dto: DecideLeaveRequestDto): Promise<void> {
    const approved = dto.decision === LeaveRequestStatus.APPROVED;
    const requestedDays = inclusiveDayCount(request.dateRangeStart, request.dateRangeEnd);
    try {
      await this.auditClient.recordEvent({
        tenantId: request.tenantId,
        actorId: dto.decidedBy,
        actorType: 'user',
        action: approved ? 'approve_backdated_leave_request' : 'reject_backdated_leave_request',
        resourceType: 'leave_request',
        resourceId: request.id,
        beforeStateJson: JSON.stringify({
          status: 'pending',
          dateRangeStart: request.dateRangeStart,
          dateRangeEnd: request.dateRangeEnd,
          requestedDays,
        }),
        afterStateJson: JSON.stringify({
          status: request.status,
          decidedAt: request.decidedAt,
          decidedBy: request.decidedBy,
          backdatedApprovedBy: request.backdatedApprovedBy,
          payrollResyncRequired: approved,
        }),
        aiRationaleJson: '',
      });
      this.metrics.recordBackdatedAuditEvent('published');
    } catch (err) {
      // Best-effort (class doc comment) - the decision itself already
      // committed to Postgres and is not rolled back for an audit-call
      // failure, consistent with core's own AuditService being documented
      // as fire-and-forget from the caller's side. Logged at ERROR (not
      // WARN, unlike the NATS publish above) given this is a compliance
      // record, not a proactive-refresh optimization - and counted, so a
      // string of failures is something to alert on rather than discover
      // later.
      this.logger.error(`Failed to record audit event for backdated LeaveRequest ${request.id}: ${String(err)}`);
      this.metrics.recordBackdatedAuditEvent('failed');
    }
  }

  /** §0.5's own SLO measured from here (decision committed) to the publish resolving - the slice of the full propagation latency this module's push path controls. */
  private async publishApproval(request: LeaveRequest): Promise<void> {
    const start = process.hrtime.bigint();
    const payload: LeaveRequestApprovedPayload = {
      tenantId: request.tenantId,
      leaveRequestId: request.id,
      employeeId: request.employeeId,
      leaveTypeId: request.leaveTypeId,
      dateRangeStart: request.dateRangeStart,
      dateRangeEnd: request.dateRangeEnd,
      decidedAt: (request.decidedAt as Date).toISOString(),
      decidedBy: request.decidedBy as string,
    };
    try {
      await this.natsClient.publish(
        ATTENDANCE_LEAVE_SUBJECTS.LEAVE_REQUEST_APPROVED,
        payload as unknown as Record<string, unknown>,
        request.id,
      );
      this.metrics.observeLeaveApprovalPropagation(Number(process.hrtime.bigint() - start) / 1e9);
    } catch (err) {
      // Best-effort (this class's own doc comment) - scheduling-service's
      // pull path (LeaveService.GetUnavailability) is still correct
      // without this; a failed publish is a missed proactive-refresh
      // opportunity, not a correctness gap. Not counted toward the
      // propagation-latency metric, since it never actually propagated via
      // this mechanism.
      this.logger.warn(`Failed to publish leave.request.approved for ${request.id}: ${String(err)}`);
    }
  }

  private async applyDecision(
    manager: EntityManager,
    tenantId: string,
    leaveRequestId: string,
    dto: DecideLeaveRequestDto,
  ): Promise<LeaveRequest> {
    const request = await manager
      .createQueryBuilder(LeaveRequest, 'request')
      .setLock('pessimistic_write')
      .where('request.id = :id', { id: leaveRequestId })
      .andWhere('request.tenantId = :tenantId', { tenantId })
      .getOne();
    if (!request) {
      throw new LeaveRequestNotFoundError(leaveRequestId);
    }
    if (request.status !== LeaveRequestStatus.PENDING) {
      throw new LeaveRequestAlreadyDecidedError(leaveRequestId, request.status);
    }

    // §5.1/ADR-0079: checked before the LeaveBalance row is locked - a
    // permission denial should not acquire a lock it will never use.
    // Rejecting a backdated request needs no elevated permission; only
    // approving one does.
    if (
      request.isBackdated &&
      dto.decision === LeaveRequestStatus.APPROVED &&
      !dto.actorPermissions?.includes(BACKDATED_LEAVE_APPROVE_PERMISSION)
    ) {
      throw new InsufficientPermissionError(BACKDATED_LEAVE_APPROVE_PERMISSION);
    }

    const balance = await manager
      .createQueryBuilder(LeaveBalance, 'balance')
      .setLock('pessimistic_write')
      .where('balance.tenantId = :tenantId', { tenantId })
      .andWhere('balance.employeeId = :employeeId', { employeeId: request.employeeId })
      .andWhere('balance.leaveTypeId = :leaveTypeId', { leaveTypeId: request.leaveTypeId })
      .andWhere('balance.periodStart <= :start', { start: request.dateRangeStart })
      .andWhere('balance.periodEnd >= :end', { end: request.dateRangeEnd })
      .getOne();
    if (!balance) {
      // Genuinely shouldn't happen - the reservation that created this
      // pending request already proved this row existed. Fails closed
      // (no decision applied) rather than guessing, consistent with §2.2
      // rule 1's posture everywhere else in this module.
      throw new LeaveBalanceNotFoundError(request.employeeId, request.leaveTypeId);
    }

    const requestedDays = inclusiveDayCount(request.dateRangeStart, request.dateRangeEnd);
    const balancePk = {
      employeeId: balance.employeeId,
      leaveTypeId: balance.leaveTypeId,
      periodStart: balance.periodStart,
      periodEnd: balance.periodEnd,
    };

    await manager.decrement(LeaveBalance, balancePk, 'pendingDays', requestedDays);
    if (dto.decision === LeaveRequestStatus.APPROVED) {
      await manager.increment(LeaveBalance, balancePk, 'usedDays', requestedDays);
    }

    await manager.update(
      LeaveRequest,
      { id: leaveRequestId },
      {
        status: dto.decision,
        decidedAt: new Date(),
        decidedBy: dto.decidedBy,
        // §2 (Attendance & Leave Manager Views phase): only present on a
        // rejection (`DecideLeaveRequestDto`'s `@ValidateIf` enforces it's
        // required there); `undefined` on an approval leaves this column
        // untouched by `manager.update`, so it stays whatever it already
        // was (always null for a first decision).
        decisionReason: dto.reason,
        // Only an approved backdated request gets `backdatedApprovedBy`
        // set - a rejected one was never actually approved by anyone, so
        // it stays null even though the permission check above didn't
        // apply to this path. Same actor as `decidedBy`: the elevated
        // permission this method already verified belongs to whoever
        // decided it, there is no separate co-signer role in this phase.
        backdatedApprovedBy: request.isBackdated && dto.decision === LeaveRequestStatus.APPROVED ? dto.decidedBy : null,
      },
    );

    return manager.findOneByOrFail(LeaveRequest, { id: leaveRequestId });
  }
}
