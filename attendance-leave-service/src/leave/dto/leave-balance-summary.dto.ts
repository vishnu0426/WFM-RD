import { LeaveBalance } from '../entities/leave-balance.entity';

/**
 * `GET /v1/leave/employees/{employeeId}/balances` (Module 11 Phase 7,
 * docs/adr/0156). Deliberately not the raw `LeaveBalance` entity -
 * `availableDays` is computed here rather than left to the caller.
 * `LeaveBalance`'s own doc comment already says it was meant to be "a
 * GraphQL computed field added in a later phase, not a column" - this is
 * that phase, and computing it server-side avoids making the mobile
 * client reimplement `accruedDays - usedDays - pendingDays` itself.
 */
export class LeaveBalanceSummaryDto {
  leaveTypeId!: string;
  periodStart!: string;
  periodEnd!: string;
  accruedDays!: string;
  usedDays!: string;
  pendingDays!: string;
  availableDays!: string;
  carryoverDaysIn!: string;
  carryoverExpiryDate!: string | null;
}

export function toLeaveBalanceSummary(balance: LeaveBalance): LeaveBalanceSummaryDto {
  const availableDays = Number(balance.accruedDays) - Number(balance.usedDays) - Number(balance.pendingDays);
  return {
    leaveTypeId: balance.leaveTypeId,
    periodStart: balance.periodStart,
    periodEnd: balance.periodEnd,
    accruedDays: balance.accruedDays,
    usedDays: balance.usedDays,
    pendingDays: balance.pendingDays,
    availableDays: availableDays.toFixed(2),
    carryoverDaysIn: balance.carryoverDaysIn,
    carryoverExpiryDate: balance.carryoverExpiryDate,
  };
}
