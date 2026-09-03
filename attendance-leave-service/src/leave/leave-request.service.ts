import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { LeaveBalance } from './entities/leave-balance.entity';
import { LeaveRequest, LeaveRequestStatus } from './entities/leave-request.entity';
import { LeaveType } from './entities/leave-type.entity';
import { LeaveConflictCheckService } from './leave-conflict-check.service';
import { LeaveApprovalQueueService } from './bullmq/leave-approval-queue.service';
import { RequestLeaveDto } from './dto/request-leave.dto';
import { SubmitBackdatedLeaveDto } from './dto/submit-backdated-leave.dto';
import { InvalidLeaveRequestError } from '../common/errors/invalid-leave-request.error';
import { BackdatedLeaveNotSupportedError } from '../common/errors/backdated-leave-not-supported.error';
import { NotActuallyBackdatedError } from '../common/errors/not-actually-backdated.error';
import { LeaveBalanceNotFoundError } from '../common/errors/leave-balance-not-found.error';
import { InsufficientLeaveBalanceError } from '../common/errors/insufficient-leave-balance.error';
import { LeaveRequestOverlapError } from '../common/errors/leave-request-overlap.error';
import { MetricsService } from '../common/metrics/metrics.service';
import { withTenantConnection } from '../database/with-tenant-connection';
import { getNumberConfig } from '../common/config/get-number-config';
import { isExclusionViolation } from '../database/postgres-error-codes';

interface ReservationResult {
  leaveRequest: LeaveRequest;
  requiresApproval: boolean;
  approvalChainId: string | null;
}

/**
 * §2.2 rule 1/2, §3.3, ADR-0074: `requestLeave` end to end -
 * validate -> synchronous conflict check (outside any transaction) ->
 * row-locked balance check + reservation + insert (one transaction) ->
 * (Phase 4) enqueue the approval-chain reminder job, outside that
 * transaction, only if the leave type actually requires a decision.
 *
 * Ordering is load-bearing, not incidental: the `LeaveConflictCheckService`
 * HTTP call to `scheduling-service` always completes *before*
 * `withTenantConnection` opens - ADR-0074's own binding note ("the
 * synchronous gRPC/REST conflict-check calls... must happen before opening
 * this transaction, not inside it") exists specifically so a slow
 * `scheduling-service` response never holds the `LeaveBalance` row lock
 * open. The same principle extends to `LeaveApprovalQueueService` (Redis) -
 * it is called only after the Postgres transaction has already committed,
 * never inside it (ADR-0077's own reasoning for why this is safe as a
 * best-effort, non-transactional call).
 */
@Injectable()
export class LeaveRequestService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly conflictCheck: LeaveConflictCheckService,
    private readonly approvalQueue: LeaveApprovalQueueService,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
  ) {}

  async requestLeave(tenantId: string, dto: RequestLeaveDto, authHeader?: string): Promise<LeaveRequest> {
    if (dto.dateRangeEnd < dto.dateRangeStart) {
      throw new InvalidLeaveRequestError('dateRangeEnd must not be before dateRangeStart.');
    }

    const requestedAt = new Date();
    const todayUtc = requestedAt.toISOString().slice(0, 10);
    if (dto.dateRangeStart < todayUtc) {
      throw new BackdatedLeaveNotSupportedError();
    }

    // §2.2 rule 2: synchronous, before any Postgres write, fails closed on
    // a scheduling-service outage (LeaveConflictCheckService's own doc
    // comment). `authHeader` relays the original caller's own token - see
    // ScheduleServiceClient's own doc comment for why this is needed now.
    const conflictFlags = await this.conflictCheck.check(
      tenantId,
      dto.employeeId,
      dto.dateRangeStart,
      dto.dateRangeEnd,
      authHeader,
    );
    const requestedDays = inclusiveDayCount(dto.dateRangeStart, dto.dateRangeEnd);

    const start = process.hrtime.bigint();
    let reservation: ReservationResult;
    try {
      reservation = await withTenantConnection(this.dataSource, tenantId, (manager) =>
        this.reserveAndSubmit(
          manager,
          tenantId,
          dto,
          requestedAt,
          requestedDays,
          conflictFlags as unknown as Record<string, unknown>,
          { forcePending: false, isBackdated: false, backdatedReason: null },
        ),
      );
      this.metrics.recordLeaveRequestSubmission('accepted');
    } catch (err) {
      this.metrics.recordLeaveRequestSubmission(
        err instanceof InsufficientLeaveBalanceError || err instanceof LeaveBalanceNotFoundError ? 'rejected' : 'error',
      );
      throw err;
    } finally {
      this.metrics.observeLeaveBalanceLockDuration(secondsSince(start));
    }

    if (reservation.requiresApproval && reservation.approvalChainId) {
      const delayMs = getNumberConfig(this.config, 'LEAVE_APPROVAL_REMINDER_DELAY_MS', 600_000);
      await this.approvalQueue.scheduleReminder(
        { tenantId, leaveRequestId: reservation.leaveRequest.id, approvalChainId: reservation.approvalChainId },
        delayMs,
      );
    }

    return reservation.leaveRequest;
  }

  /**
   * §3.1/§5.1's `submitBackdatedLeave` - a separate mutation, not an
   * overload of `requestLeave` (see `SubmitBackdatedLeaveDto`'s doc
   * comment). Shares `reserveAndSubmit`'s row-locking/balance-reservation
   * logic rather than duplicating it (the concurrency-critical part of
   * this flow has exactly one implementation, ADR-0079) - the only real
   * differences are the date-direction check (past, not future) and the
   * `forcePending: true` option, which makes a backdated entry always
   * require a human decision regardless of `LeaveType.requiresApproval`:
   * §5.1 frames backdated entries as carrying "direct payroll/compliance
   * implications a normal forward-dated request doesn't," which is reason
   * enough that a leave type configured to auto-approve should not also
   * silently auto-approve a backdated claim against it.
   */
  async submitBackdatedLeave(tenantId: string, dto: SubmitBackdatedLeaveDto, authHeader?: string): Promise<LeaveRequest> {
    if (dto.dateRangeEnd < dto.dateRangeStart) {
      throw new InvalidLeaveRequestError('dateRangeEnd must not be before dateRangeStart.');
    }

    const requestedAt = new Date();
    const todayUtc = requestedAt.toISOString().slice(0, 10);
    if (dto.dateRangeStart >= todayUtc) {
      throw new NotActuallyBackdatedError();
    }

    // §2.2 rule 2: same synchronous, fail-closed conflict check as
    // `requestLeave` - §5.1 gives backdated entries a *stricter* audit
    // path, not an exemption from the ordinary conflict pipeline.
    const conflictFlags = await this.conflictCheck.check(
      tenantId,
      dto.employeeId,
      dto.dateRangeStart,
      dto.dateRangeEnd,
      authHeader,
    );
    const requestedDays = inclusiveDayCount(dto.dateRangeStart, dto.dateRangeEnd);

    const start = process.hrtime.bigint();
    let reservation: ReservationResult;
    try {
      reservation = await withTenantConnection(this.dataSource, tenantId, (manager) =>
        this.reserveAndSubmit(
          manager,
          tenantId,
          dto,
          requestedAt,
          requestedDays,
          conflictFlags as unknown as Record<string, unknown>,
          { forcePending: true, isBackdated: true, backdatedReason: dto.backdatedReason },
        ),
      );
      this.metrics.recordBackdatedLeaveSubmission('accepted');
    } catch (err) {
      this.metrics.recordBackdatedLeaveSubmission(
        err instanceof InsufficientLeaveBalanceError || err instanceof LeaveBalanceNotFoundError ? 'rejected' : 'error',
      );
      throw err;
    } finally {
      this.metrics.observeLeaveBalanceLockDuration(secondsSince(start));
    }

    // forcePending guarantees requiresApproval/approvalChainId are always
    // set here - the reminder is scheduled unconditionally, unlike
    // requestLeave's conditional branch.
    const delayMs = getNumberConfig(this.config, 'LEAVE_APPROVAL_REMINDER_DELAY_MS', 600_000);
    await this.approvalQueue.scheduleReminder(
      { tenantId, leaveRequestId: reservation.leaveRequest.id, approvalChainId: reservation.approvalChainId as string },
      delayMs,
    );

    return reservation.leaveRequest;
  }

  /**
   * §2.2 rule 1/ADR-0074: `SELECT ... FOR UPDATE` on the exact composite PK
   * that also identifies the balance period covering this request's date
   * range - the row-lock granularity ADR-0074 designed this schema's PK
   * around. `availableDays` is computed from the locked read, never a
   * separate earlier read, so a concurrent submission against the same row
   * genuinely blocks here rather than racing.
   *
   * No separate `leave_type_id` existence check: this query is keyed by
   * `leaveTypeId`, so an id with no matching `LeaveBalance` row always hits
   * `LeaveBalanceNotFoundError` below, before any write is attempted - and
   * a `LeaveBalance` row can only exist for a `leaveTypeId` the Phase 3
   * migration's FK already validated when that row was created. An
   * application-level "does this leave type exist" check here would be
   * genuinely unreachable dead code, not defense in depth - confirmed by
   * testing an earlier version of this method that had one. The FK itself
   * remains the real safety net for any future write path that might skip
   * this lookup. `LeaveType` itself is fetched (read-only, no lock needed -
   * nothing in this module mutates it) purely to branch on
   * `requiresApproval`.
   *
   * §0.5's auto-approval warning ("feature-flagged, opt-in, never default")
   * is about a *tenant-wide* override that skips approval regardless of
   * configuration - not built here. `LeaveType.requiresApproval` is
   * ordinary, per-leave-type data already shaped into the schema since
   * Phase 1; honoring it is the schema doing what it was built for, not the
   * risky capability §0.5 warns about.
   *
   * `options.forcePending` (Phase 6): `submitBackdatedLeave` always takes
   * the pending/reservation branch below, even for a `LeaveType` with
   * `requiresApproval: false` - see `submitBackdatedLeave`'s own doc
   * comment for why. `options.isBackdated`/`backdatedReason` are threaded
   * into both insert branches (rather than hardcoded) so this one method
   * stays the single place either mutation writes a `LeaveRequest` row -
   * the non-pending branch never actually receives `isBackdated: true` in
   * practice (forcePending guarantees the pending branch is taken whenever
   * it's true), but leaving the parameter live here (instead of
   * hardcoding `false`/`null` in this method and re-deriving it at both
   * call sites) is what keeps this the one method that decides the
   * column's value.
   */
  private async reserveAndSubmit(
    manager: EntityManager,
    tenantId: string,
    dto: BackdatableLeaveInput,
    requestedAt: Date,
    requestedDays: number,
    conflictFlags: Record<string, unknown>,
    options: { forcePending: boolean; isBackdated: boolean; backdatedReason: string | null },
  ): Promise<ReservationResult> {
    const balance = await manager
      .createQueryBuilder(LeaveBalance, 'balance')
      .setLock('pessimistic_write')
      .where('balance.tenantId = :tenantId', { tenantId })
      .andWhere('balance.employeeId = :employeeId', { employeeId: dto.employeeId })
      .andWhere('balance.leaveTypeId = :leaveTypeId', { leaveTypeId: dto.leaveTypeId })
      .andWhere('balance.periodStart <= :start', { start: dto.dateRangeStart })
      .andWhere('balance.periodEnd >= :end', { end: dto.dateRangeEnd })
      .getOne();
    if (!balance) {
      throw new LeaveBalanceNotFoundError(dto.employeeId, dto.leaveTypeId);
    }

    const availableDays = Number(balance.accruedDays) - Number(balance.usedDays) - Number(balance.pendingDays);
    if (requestedDays > availableDays) {
      throw new InsufficientLeaveBalanceError(requestedDays, availableDays);
    }

    const leaveType = await manager.findOneByOrFail(LeaveType, { id: balance.leaveTypeId });
    const balancePk = {
      employeeId: balance.employeeId,
      leaveTypeId: balance.leaveTypeId,
      periodStart: balance.periodStart,
      periodEnd: balance.periodEnd,
    };
    const id = randomUUID();

    if (leaveType.requiresApproval || options.forcePending) {
      const approvalChainId = randomUUID();
      await manager.increment(LeaveBalance, balancePk, 'pendingDays', requestedDays);
      await this.insertLeaveRequestOrThrowOverlap(manager, dto, {
        id,
        tenantId,
        employeeId: dto.employeeId,
        leaveTypeId: dto.leaveTypeId,
        dateRangeStart: dto.dateRangeStart,
        dateRangeEnd: dto.dateRangeEnd,
        status: LeaveRequestStatus.PENDING,
        approvalChainId,
        requestedAt,
        decidedAt: null,
        decidedBy: null,
        conflictFlags: asJsonbValue(conflictFlags),
        isBackdated: options.isBackdated,
        backdatedReason: options.backdatedReason,
        backdatedApprovedBy: null,
      });
      const leaveRequest = await manager.findOneByOrFail(LeaveRequest, { id });
      return { leaveRequest, requiresApproval: true, approvalChainId };
    }

    // requiresApproval === false (and not forced pending): no chain, no
    // reservation step - goes straight to used_days, decided by nobody (a
    // system/data-driven decision, not a human one - decidedBy stays
    // null). Never reached with isBackdated: true - forcePending is
    // always set for that case (see submitBackdatedLeave).
    await manager.increment(LeaveBalance, balancePk, 'usedDays', requestedDays);
    await this.insertLeaveRequestOrThrowOverlap(manager, dto, {
      id,
      tenantId,
      employeeId: dto.employeeId,
      leaveTypeId: dto.leaveTypeId,
      dateRangeStart: dto.dateRangeStart,
      dateRangeEnd: dto.dateRangeEnd,
      status: LeaveRequestStatus.APPROVED,
      approvalChainId: null,
      requestedAt,
      decidedAt: requestedAt,
      decidedBy: null,
      conflictFlags: asJsonbValue(conflictFlags),
      isBackdated: options.isBackdated,
      backdatedReason: options.backdatedReason,
      backdatedApprovedBy: null,
    });
    const leaveRequest = await manager.findOneByOrFail(LeaveRequest, { id });
    return { leaveRequest, requiresApproval: false, approvalChainId: null };
  }

  /**
   * GAP-09 fix (enterprise readiness audit, 2026-08-18): both insert sites
   * in `reserveAndSubmit` share this - `leave_request_no_overlapping_active_ranges`
   * (an EXCLUDE constraint, see `1700001100000-LeaveRequestNoOverlappingActiveRanges`)
   * is the real enforcement point for "no two pending/approved leave
   * requests with overlapping dates for the same employee," not
   * `LeaveConflictCheckService` (which only ever checked the shift
   * schedule, never this table). A violation surfaces as a real Postgres
   * exclusion-violation (`23P01`), caught here and converted to the
   * typed, REST-mapped `LeaveRequestOverlapError`.
   */
  private async insertLeaveRequestOrThrowOverlap(
    manager: EntityManager,
    dto: BackdatableLeaveInput,
    values: QueryDeepPartialEntity<LeaveRequest>,
  ): Promise<void> {
    try {
      await manager.insert(LeaveRequest, values);
    } catch (err) {
      if (isExclusionViolation(err)) {
        throw new LeaveRequestOverlapError(dto.employeeId, dto.dateRangeStart, dto.dateRangeEnd);
      }
      throw err;
    }
  }
}

/** The subset of `RequestLeaveDto`/`SubmitBackdatedLeaveDto` `reserveAndSubmit` actually needs - both DTOs shape-match this without either needing to extend the other (their validation rules differ, per §3.1/§5.1). */
interface BackdatableLeaveInput {
  employeeId: string;
  leaveTypeId: string;
  dateRangeStart: string;
  dateRangeEnd: string;
}

/**
 * TypeORM's `QueryDeepPartialEntity` mapped type doesn't cleanly accept a
 * plain `Record<string, unknown>` value for a jsonb column typed the same
 * way - a known TypeORM typing limitation, not a real type mismatch (the
 * runtime value is exactly what the jsonb column expects).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asJsonbValue(value: Record<string, unknown>): any {
  return value;
}

/**
 * Both bounds are `YYYY-MM-DD` (date-only, no timezone) - inclusive day
 * count, e.g. same day = 1. No half-day leave in this phase (Phase 3
 * design doc's explicit assumption). Exported so `DecideLeaveRequestService`
 * (Phase 4) computes the exact same day count for the same request when
 * releasing/consuming its reservation - never re-derived differently.
 */
export function inclusiveDayCount(dateRangeStart: string, dateRangeEnd: string): number {
  const start = Date.UTC(...parseDateParts(dateRangeStart));
  const end = Date.UTC(...parseDateParts(dateRangeEnd));
  return Math.round((end - start) / 86_400_000) + 1;
}

function parseDateParts(date: string): [number, number, number] {
  const [year, month, day] = date.split('-').map(Number);
  return [year, month - 1, day];
}

function secondsSince(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e9;
}
