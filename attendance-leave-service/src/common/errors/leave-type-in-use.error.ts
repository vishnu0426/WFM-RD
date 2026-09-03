import { DomainError } from './domain-error';

/** Thrown when a `LeaveType` delete hits `leave_balance_leave_type_id_fkey`/`leave_request_leave_type_id_fkey` (`1700000800000-LeaveTypeForeignKeys.ts`) — translates the DB's own referential-integrity rejection into this platform's standard error envelope instead of a raw 500. */
export class LeaveTypeInUseError extends DomainError {
  constructor(leaveTypeId: string) {
    super('LEAVE_TYPE_IN_USE', `LeaveType ${leaveTypeId} is referenced by existing leave requests or balances and cannot be deleted.`);
  }
}
