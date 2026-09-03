import { DomainError } from './domain-error';

export class LeaveTypeNotFoundError extends DomainError {
  constructor(leaveTypeId: string) {
    super('LEAVE_TYPE_NOT_FOUND', `No LeaveType exists with id ${leaveTypeId}.`);
  }
}
