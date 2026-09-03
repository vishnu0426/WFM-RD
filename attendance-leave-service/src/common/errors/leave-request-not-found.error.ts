import { DomainError } from './domain-error';

export class LeaveRequestNotFoundError extends DomainError {
  constructor(leaveRequestId: string) {
    super('LEAVE_REQUEST_NOT_FOUND', `No LeaveRequest exists with id ${leaveRequestId}.`);
  }
}
