import { Injectable, OnModuleInit } from '@nestjs/common';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Thin wrapper over `prom-client`'s `Registry`, same posture as every other
 * service's `MetricsService` in this platform - `getRegistry()` is
 * available for anything not exposed here directly.
 *
 * §0.5's one real SLO for this module - leave-approval -> Module 04
 * visibility propagation, p99 < 2s - has nothing to measure yet in Phase 1
 * (no approval workflow, no Module 04 integration until Phase 4/5). The
 * histogram is declared here now, with its SLO documented inline, so Phase
 * 5's propagation code has a proven metric to record into rather than
 * inventing naming/bucket conventions under phase pressure later - same
 * "real but not yet wired" posture intraday-service's Phase 1 metrics
 * followed for `redisOperationDuration` before Phase 2 had a consumer to
 * call it from.
 */
@Injectable()
export class MetricsService implements OnModuleInit {
  private readonly registry = new Registry();

  readonly httpRequestDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  readonly httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status_code'],
    registers: [this.registry],
  });

  /**
   * ADR-0150/ADR-0157. Guard rejections, by reason
   * (unauthenticated/forbidden_tenant_mismatch/forbidden_employee_mismatch) -
   * required by `AccessTokenGuard`/`TenantTokenMatchGuard`/
   * `EmployeeSessionVerificationService`, copied from mobile-ess-service
   * (docs/adr/0130), recorded directly inside the guards themselves since
   * Guards run before Interceptors in NestJS's request lifecycle.
   * `forbidden_permission` added for `PermissionsGuard` (Attendance & Leave
   * Manager Views phase), same reason value adherence-compliance-service's
   * own copy already uses.
   */
  readonly rbacDenialsTotal = new Counter({
    name: 'attendance_leave_rbac_denials_total',
    help: 'RBAC guard rejections, by reason',
    labelNames: ['reason'],
    registers: [this.registry],
  });

  /**
   * §0.5's core correctness SLO: p99 < 2s from `decideLeaveRequest`
   * mutation completing to the employee being excluded from Module 04's
   * `GetSchedulableEmployees` (or, on this module's own side, from the
   * `agno.leave.request.approved.v1` NATS publish landing). Wired in
   * Phase 5 (§3.4) - unused until then.
   */
  readonly leaveApprovalPropagationDuration = new Histogram({
    name: 'attendance_leave_approval_propagation_duration_seconds',
    help: "decideLeaveRequest approval -> Module 04 visibility propagation latency - this module's §0.5 SLO (p99 < 2s)",
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 1.5, 2, 3, 5, 10],
    registers: [this.registry],
  });

  /** Phase 2 (§3.2): clock-event webhook ingestion outcomes. */
  readonly attendanceIngestionEventsTotal = new Counter({
    name: 'attendance_ingestion_events_total',
    help: 'Clock-event webhook ingestion outcomes (accepted/duplicate/rejected/upstream_unavailable)',
    labelNames: ['result'],
    registers: [this.registry],
  });

  /** Phase 2: latency of the idempotency-ledger INSERT that decides accepted-vs-duplicate (ADR-0075). */
  readonly attendanceLedgerInsertDuration = new Histogram({
    name: 'attendance_ledger_insert_duration_seconds',
    help: 'attendance_ingestion_event INSERT duration, including the unique-violation dedup path (ADR-0075)',
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [this.registry],
  });

  /** Phase 3 (§2.2 rule 1): requestLeave submission outcomes. */
  readonly leaveRequestSubmissionsTotal = new Counter({
    name: 'leave_request_submissions_total',
    help: 'requestLeave submission outcomes (accepted/rejected/error)',
    labelNames: ['result'],
    registers: [this.registry],
  });

  /** Phase 3 (ADR-0074): time the LeaveBalance row lock is held - the submission's own `SELECT ... FOR UPDATE` through commit/rollback. */
  readonly leaveBalanceLockDuration = new Histogram({
    name: 'leave_balance_lock_duration_seconds',
    help: "LeaveBalance row-lock hold time during requestLeave - §6's concurrency-safety mechanism, watched for unexpectedly long holds",
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  /** Phase 4 (§3.3): decideLeaveRequest outcomes. */
  readonly leaveRequestDecisionsTotal = new Counter({
    name: 'leave_request_decisions_total',
    help: 'decideLeaveRequest outcomes (approved/rejected/error)',
    labelNames: ['result'],
    registers: [this.registry],
  });

  /** Phase 4 (ADR-0077): a leave-approval-reminders job fired while its LeaveRequest was still pending - the closest signal this phase has to "stale approval," with no real notification channel behind it yet. */
  readonly leaveApprovalRemindersFiredTotal = new Counter({
    name: 'leave_approval_reminders_fired_total',
    help: 'Count of leave-approval-reminders BullMQ jobs that fired while their LeaveRequest was still pending',
    registers: [this.registry],
  });

  /** Phase 6 (§5.1): submitBackdatedLeave outcomes - a separate counter from `leaveRequestSubmissionsTotal` since these two mutations are deliberately distinct surfaces (ADR-0079). */
  readonly leaveBackdatedSubmissionsTotal = new Counter({
    name: 'leave_backdated_submissions_total',
    help: 'submitBackdatedLeave submission outcomes (accepted/rejected/error)',
    labelNames: ['result'],
    registers: [this.registry],
  });

  /** Phase 6 (§5.1, ADR-0079): a backdated decideLeaveRequest was rejected specifically for lacking the elevated backdated_leave_entry:approve permission - distinct from an ordinary rejected/approved decision. */
  readonly leaveBackdatedPermissionDenialsTotal = new Counter({
    name: 'leave_backdated_permission_denials_total',
    help: 'Count of decideLeaveRequest calls on an is_backdated request rejected for missing backdated_leave_entry:approve',
    registers: [this.registry],
  });

  /** Phase 6: outcome of the best-effort AuditService.RecordEvent call made for every decided backdated LeaveRequest (§5.1's audit-trail requirement). A "failed" event is not lost from this module's own decision (Postgres stays authoritative for the decision itself), but it is a compliance-relevant gap worth alerting on - unlike the ordinary NATS publish, which has no dedicated counter of its own. */
  readonly leaveBackdatedAuditEventsTotal = new Counter({
    name: 'leave_backdated_audit_events_total',
    help: 'Outcome of the AuditService.RecordEvent call made for each decided backdated LeaveRequest (published/failed)',
    labelNames: ['result'],
    registers: [this.registry],
  });

  /** Phase 7 (§5.2, ADR-0080): LeaveCarryoverJobService.rolloverTick outcomes, across every tenant in one cross-tenant UPDATE. */
  readonly leaveCarryoverRolloverRunsTotal = new Counter({
    name: 'leave_carryover_rollover_runs_total',
    help: 'LeaveCarryoverJobService rollover tick outcomes (success/error)',
    labelNames: ['result'],
    registers: [this.registry],
  });

  /** Phase 7: how many LeaveBalance rows (successor periods) received a carryover application (including a legitimate zero) on the most recent successful rollover tick. */
  readonly leaveCarryoverBalancesRolledOverTotal = new Counter({
    name: 'leave_carryover_balances_rolled_over_total',
    help: 'Count of LeaveBalance rows that received a carryover application (rollover tick)',
    registers: [this.registry],
  });

  /** Phase 7: total days actually carried over (capped by LeaveType.carryoverRules.maxCarryoverDays) - distinct from the row count above, since most of those rows carry over 0. */
  readonly leaveCarryoverDaysRolledOverTotal = new Counter({
    name: 'leave_carryover_days_rolled_over_total',
    help: 'Sum of days actually carried over across all LeaveBalance rows processed by the rollover tick',
    registers: [this.registry],
  });

  /** User Management audit GAP-02: LeaveAccrualJobService tick outcomes, across every tenant in one cross-tenant UPDATE — same shape as the rollover counters above. */
  readonly leaveAccrualRunsTotal = new Counter({
    name: 'leave_accrual_runs_total',
    help: 'LeaveAccrualJobService tick outcomes (success/error)',
    labelNames: ['result'],
    registers: [this.registry],
  });

  readonly leaveAccrualBalancesAccruedTotal = new Counter({
    name: 'leave_accrual_balances_accrued_total',
    help: 'Count of LeaveBalance rows that received an accrual application on the most recent successful accrual tick',
    registers: [this.registry],
  });

  readonly leaveAccrualDaysAccruedTotal = new Counter({
    name: 'leave_accrual_days_accrued_total',
    help: 'Sum of days accrued across all LeaveBalance rows processed by the accrual tick',
    registers: [this.registry],
  });

  /** Phase 7: LeaveCarryoverJobService.expiryTick outcomes. */
  readonly leaveCarryoverExpiryRunsTotal = new Counter({
    name: 'leave_carryover_expiry_runs_total',
    help: 'LeaveCarryoverJobService expiry tick outcomes (success/error)',
    labelNames: ['result'],
    registers: [this.registry],
  });

  /** Phase 7: how many LeaveBalance rows had expired, unused carryover clawed back on the most recent successful expiry tick. */
  readonly leaveCarryoverBalancesExpiredTotal = new Counter({
    name: 'leave_carryover_balances_expired_total',
    help: 'Count of LeaveBalance rows that had expired carryover clawed back (expiry tick)',
    registers: [this.registry],
  });

  /** Phase 7: total days clawed back for having expired unused. */
  readonly leaveCarryoverDaysExpiredTotal = new Counter({
    name: 'leave_carryover_days_expired_total',
    help: 'Sum of days clawed back across all LeaveBalance rows processed by the expiry tick',
    registers: [this.registry],
  });

  /** Phase 8 (§2.1, ADR-0081): AbsencePatternDetectionJob step outcomes - one label value per step (frequency_threshold/recurring_day_of_week/pre_post_holiday), since the holiday step's per-tenant gRPC dependency fails independently of the two pure-SQL steps. */
  readonly absencePatternDetectionRunsTotal = new Counter({
    name: 'absence_pattern_detection_runs_total',
    help: 'AbsencePatternDetectionJob step outcomes (success/error) by step',
    labelNames: ['step', 'result'],
    registers: [this.registry],
  });

  /** Phase 8: new AbsencePattern rows actually inserted (i.e. that passed the unacknowledged-dedup check), by pattern type. */
  readonly absencePatternsDetectedTotal = new Counter({
    name: 'absence_patterns_detected_total',
    help: 'New AbsencePattern rows inserted by AbsencePatternDetectionJob, by pattern_type',
    labelNames: ['pattern_type'],
    registers: [this.registry],
  });

  /** Phase 8: acknowledgeAbsencePattern outcomes. */
  readonly absencePatternAcknowledgementsTotal = new Counter({
    name: 'absence_pattern_acknowledgements_total',
    help: 'acknowledgeAbsencePattern outcomes (acknowledged/rejected/error)',
    labelNames: ['result'],
    registers: [this.registry],
  });

  onModuleInit(): void {
    collectDefaultMetrics({ register: this.registry });
  }

  getRegistry(): Registry {
    return this.registry;
  }

  observeHttpRequest(method: string, route: string, statusCode: number, durationSeconds: number): void {
    const labels = { method, route, status_code: String(statusCode) };
    this.httpRequestDuration.observe(labels, durationSeconds);
    this.httpRequestsTotal.inc(labels);
  }

  recordRbacDenial(
    reason: 'unauthenticated' | 'forbidden_tenant_mismatch' | 'forbidden_employee_mismatch' | 'forbidden_permission',
  ): void {
    this.rbacDenialsTotal.inc({ reason });
  }

  observeLeaveApprovalPropagation(durationSeconds: number): void {
    this.leaveApprovalPropagationDuration.observe(durationSeconds);
  }

  recordAttendanceIngestionEvent(result: 'accepted' | 'duplicate' | 'rejected' | 'upstream_unavailable'): void {
    this.attendanceIngestionEventsTotal.inc({ result });
  }

  observeAttendanceLedgerInsert(durationSeconds: number): void {
    this.attendanceLedgerInsertDuration.observe(durationSeconds);
  }

  recordLeaveRequestSubmission(result: 'accepted' | 'rejected' | 'error'): void {
    this.leaveRequestSubmissionsTotal.inc({ result });
  }

  observeLeaveBalanceLockDuration(durationSeconds: number): void {
    this.leaveBalanceLockDuration.observe(durationSeconds);
  }

  recordLeaveRequestDecision(result: 'approved' | 'rejected' | 'error'): void {
    this.leaveRequestDecisionsTotal.inc({ result });
  }

  recordLeaveApprovalReminderFired(): void {
    this.leaveApprovalRemindersFiredTotal.inc();
  }

  recordBackdatedLeaveSubmission(result: 'accepted' | 'rejected' | 'error'): void {
    this.leaveBackdatedSubmissionsTotal.inc({ result });
  }

  recordBackdatedPermissionDenial(): void {
    this.leaveBackdatedPermissionDenialsTotal.inc();
  }

  recordBackdatedAuditEvent(result: 'published' | 'failed'): void {
    this.leaveBackdatedAuditEventsTotal.inc({ result });
  }

  recordCarryoverRolloverRun(result: 'success' | 'error', balancesRolledOver = 0, daysRolledOver = 0): void {
    this.leaveCarryoverRolloverRunsTotal.inc({ result });
    this.leaveCarryoverBalancesRolledOverTotal.inc(balancesRolledOver);
    this.leaveCarryoverDaysRolledOverTotal.inc(daysRolledOver);
  }

  recordCarryoverExpiryRun(result: 'success' | 'error', balancesExpired = 0, daysExpired = 0): void {
    this.leaveCarryoverExpiryRunsTotal.inc({ result });
    this.leaveCarryoverBalancesExpiredTotal.inc(balancesExpired);
    this.leaveCarryoverDaysExpiredTotal.inc(daysExpired);
  }

  recordLeaveAccrualRun(result: 'success' | 'error', balancesAccrued = 0, daysAccrued = 0): void {
    this.leaveAccrualRunsTotal.inc({ result });
    this.leaveAccrualBalancesAccruedTotal.inc(balancesAccrued);
    this.leaveAccrualDaysAccruedTotal.inc(daysAccrued);
  }

  recordAbsencePatternDetectionRun(
    step: 'frequency_threshold' | 'recurring_day_of_week' | 'pre_post_holiday',
    result: 'success' | 'error',
    detected = 0,
  ): void {
    this.absencePatternDetectionRunsTotal.inc({ step, result });
    if (detected > 0) {
      this.absencePatternsDetectedTotal.inc({ pattern_type: step }, detected);
    }
  }

  recordAbsencePatternAcknowledgement(result: 'acknowledged' | 'rejected' | 'error'): void {
    this.absencePatternAcknowledgementsTotal.inc({ result });
  }
}
