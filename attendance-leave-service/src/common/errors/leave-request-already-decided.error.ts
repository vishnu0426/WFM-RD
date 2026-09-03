import { DomainError } from './domain-error';
import { LeaveRequestStatus } from '../../leave/entities/leave-request.entity';

/** A decision was already recorded (or the request was cancelled) - decideLeaveRequest is not idempotent-by-design, unlike requestLeave's ledger-based dedup (there is no client-supplied idempotency key for a decision). */
export class LeaveRequestAlreadyDecidedError extends DomainError {
  constructor(leaveRequestId: string, currentStatus: LeaveRequestStatus) {
    super(
      'LEAVE_REQUEST_ALREADY_DECIDED',
      `LeaveRequest ${leaveRequestId} is already "${currentStatus}" and cannot be decided again.`,
    );
  }
}
