import { DomainError } from './domain-error';

/** §5.1: approving an `is_backdated` `LeaveRequest` requires the elevated `backdated_leave_entry:approve` permission (ADR-0079), never the standard leave-approver permission alone. Rejecting a backdated request does not require it - only approval carries the payroll/compliance implication §5.1 calls out. */
export class InsufficientPermissionError extends DomainError {
  constructor(requiredPermission: string) {
    super(
      'INSUFFICIENT_PERMISSION',
      `This action requires the "${requiredPermission}" permission, which the actor did not present.`,
    );
  }
}
