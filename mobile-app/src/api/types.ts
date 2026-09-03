/**
 * Mirrors scheduling-service's `EmployeeShiftAssignmentResponse` (CamelModel,
 * so JSON keys are camelCase) exactly — see
 * scheduling-service/app/api/v1/schemas.py and docs/adr/0064. No shift
 * name/code field exists on this endpoint today, only timestamps + flags.
 */
export interface ShiftAssignment {
  id: string;
  employeeId: string;
  scheduleId: string;
  shiftStart: string;
  shiftEnd: string;
  skillId: string | null;
  assignmentSource: string;
  isOvertime: boolean;
  locked: boolean;
  publishedAt: string;
}

/**
 * Mirrors intraday-service's `agentLiveState` GraphQL query result
 * exactly (docs/adr/0156). `null` fields/`dataFreshness.status: 'degraded'`
 * happen together — the Redis-outage fallback path only has the
 * employee's most-recent `AdherenceEvent` row to go on.
 */
export interface AgentLiveState {
  employeeId: string;
  currentActivity: string | null;
  activityStartedAt: string | null;
  scheduledActivity: string | null;
  adherenceStatus: string | null;
  siteId: string | null;
  queueId: string | null;
  dataFreshness: { status: 'ok' | 'degraded'; lastKnownUpdateAt: string | null };
}

/** Mirrors adherence-compliance-service's `adherenceScoreToday` GraphQL
 * query result exactly (docs/adr/0156). `adherencePct` is a percentage
 * (0-100), already computed server-side. */
export interface AdherenceScoreToday {
  employeeId: string;
  periodStart: string;
  periodEnd: string;
  adherencePct: number;
  majorDeviationCount: number;
  adherentSeconds: number;
  totalScheduledSeconds: number;
  computedAt: string;
}

/** Mirrors attendance-leave-service's `AttendanceRecord` entity exactly
 * (docs/adr/0156) — `GET /v1/attendance/employees/{employeeId}/records`
 * returns these raw, not a pre-summed total. */
export interface AttendanceRecordDto {
  id: string;
  employeeId: string;
  clockInAt: string;
  clockOutAt: string | null;
  source: string;
  scheduledShiftId: string | null;
  exceptionType: string | null;
  exceptionMinutes: number | null;
  geofenceVerified: boolean | null;
}

/** Mirrors attendance-leave-service's `LeaveBalanceSummaryDto` exactly
 * (docs/adr/0156) — `GET /v1/leave/employees/{employeeId}/balances`.
 * Numeric fields arrive as strings (Postgres `numeric` columns). */
export interface LeaveBalanceSummary {
  leaveTypeId: string;
  periodStart: string;
  periodEnd: string;
  accruedDays: string;
  usedDays: string;
  pendingDays: string;
  availableDays: string;
  carryoverDaysIn: string;
  carryoverExpiryDate: string | null;
}
