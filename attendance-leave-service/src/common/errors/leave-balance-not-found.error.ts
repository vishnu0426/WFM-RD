import { DomainError } from './domain-error';

/**
 * §2.2 rule 1: no `LeaveBalance` row covers this employee/leave-type/date-
 * range - fails closed (zero days available is the only safe default),
 * never treated as "unlimited" or auto-provisioned. See the Phase 3
 * design doc's explicit assumptions for why balance provisioning is out
 * of this module's owned mutation surface.
 */
export class LeaveBalanceNotFoundError extends DomainError {
  constructor(employeeId: string, leaveTypeId: string) {
    super(
      'LEAVE_BALANCE_NOT_FOUND',
      `No LeaveBalance record covers employee ${employeeId} / leave type ${leaveTypeId} for the requested date range.`,
    );
  }
}
